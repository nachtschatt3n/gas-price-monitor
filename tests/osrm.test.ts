import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  OsrmClient,
  OsrmError,
  canonCoord,
  tableCacheKey,
  routeCacheKey,
  type Coord,
  type StationCoord,
} from "../src/osrm.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USER: Coord = { lat: 52.52, lng: 13.405 };

const STATIONS: StationCoord[] = [
  { id: "s1", lat: 52.521, lng: 13.41 },
  { id: "s2", lat: 52.519, lng: 13.39 },
  { id: "s3", lat: 52.52, lng: 13.42 },
];

function tableBody(distances: (number | null)[], durations: (number | null)[]) {
  return {
    code: "Ok",
    distances: [distances],
    durations: [durations],
  };
}

function routeBody(coords: [number, number][], meters = 1234, seconds = 180) {
  return {
    code: "Ok",
    routes: [
      {
        geometry: { type: "LineString", coordinates: coords },
        distance: meters,
        duration: seconds,
      },
    ],
  };
}

function mockFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gas-osrm-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonCoord", () => {
  test("rounds to 5 decimals", () => {
    expect(canonCoord({ lat: 52.123456789, lng: 13.987654321 })).toEqual([52.12346, 13.98765]);
  });

  test("near-identical coords canonicalize to the same pair", () => {
    expect(canonCoord({ lat: 52.520001, lng: 13.405001 })).toEqual(
      canonCoord({ lat: 52.520003, lng: 13.405004 }),
    );
  });
});

describe("tableCacheKey", () => {
  test("station order does not affect the key", () => {
    const k1 = tableCacheKey(USER, [STATIONS[0]!, STATIONS[1]!, STATIONS[2]!]);
    const k2 = tableCacheKey(USER, [STATIONS[2]!, STATIONS[0]!, STATIONS[1]!]);
    expect(k1).toBe(k2);
  });

  test("different user coords produce different keys", () => {
    const k1 = tableCacheKey(USER, STATIONS);
    const k2 = tableCacheKey({ lat: 51, lng: 13 }, STATIONS);
    expect(k1).not.toBe(k2);
  });

  test("table and route keys never collide for the same coord pair", () => {
    const k1 = tableCacheKey(USER, [STATIONS[0]!]);
    const k2 = routeCacheKey(USER, STATIONS[0]!);
    expect(k1).not.toBe(k2);
  });
});

describe("OsrmClient", () => {
  const baseCfg = {
    baseUrl: "https://osrm.test",
    userAgent: "gas-price-monitor (test)",
    ttlMs: 60_000,
    maxEntries: 200,
  };

  describe("tableDistances", () => {
    test("empty stations short-circuits without hitting upstream", async () => {
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            calls++;
            return new Response("{}");
          }) as unknown as typeof fetch,
        },
      );
      expect(await c.tableDistances(USER, [])).toEqual({});
      expect(calls).toBe(0);
    });

    test("happy path: parses 1xN matrix and returns id-keyed map", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch(tableBody([1000, 2000, 3000], [120, 240, 360])) },
      );
      const out = await c.tableDistances(USER, STATIONS);
      expect(out).toEqual({
        s1: { meters: 1000, seconds: 120 },
        s2: { meters: 2000, seconds: 240 },
        s3: { meters: 3000, seconds: 360 },
      });
    });

    test("OSRM URL uses lng,lat (NOT lat,lng) and sources=0&destinations=...", async () => {
      let observedUrl = "";
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async (url: unknown) => {
            observedUrl = typeof url === "string" ? url : "";
            return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
          }) as unknown as typeof fetch,
        },
      );
      await c.tableDistances(USER, STATIONS);
      // user is index 0, stations 1..3, longitude first.
      expect(observedUrl).toContain("/table/v1/driving/13.405,52.52;13.41,52.521;13.39,52.519;13.42,52.52");
      expect(observedUrl).toContain("sources=0");
      // OSRM's destinations spec is SEMICOLON-separated, not comma.
      expect(observedUrl).toContain("destinations=1;2;3");
      expect(observedUrl).toContain("annotations=distance,duration");
    });

    test("null cell maps to no-route (station omitted from response)", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch(tableBody([1000, null, 3000], [120, null, 360])) },
      );
      const out = await c.tableDistances(USER, STATIONS);
      expect(out).toEqual({
        s1: { meters: 1000, seconds: 120 },
        s3: { meters: 3000, seconds: 360 },
      });
      expect(out.s2).toBeUndefined();
    });

    test("Default #21 revised: 0-cell with DIFFERENT coords treated as no-route", async () => {
      // s1 coords differ from user but OSRM returns 0 → no-route signal.
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch(tableBody([0, 2000, 3000], [0, 240, 360])) },
      );
      const out = await c.tableDistances(USER, STATIONS);
      expect(out.s1).toBeUndefined();
      expect(out.s2).toEqual({ meters: 2000, seconds: 240 });
    });

    test("Default #21 revised: 0-cell with MATCHING coords kept as ground truth (user parked at station)", async () => {
      // s4 has the same canonicalized coords as user → 0 is real.
      const parkedStation: StationCoord = { id: "parked", lat: USER.lat, lng: USER.lng };
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch(tableBody([0], [0])) },
      );
      const out = await c.tableDistances(USER, [parkedStation]);
      expect(out.parked).toEqual({ meters: 0, seconds: 0 });
    });

    test("caches: second call with same coord set hits disk, not upstream", async () => {
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            calls++;
            return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
          }) as unknown as typeof fetch,
        },
      );
      await c.tableDistances(USER, STATIONS);
      await c.tableDistances(USER, STATIONS);
      expect(calls).toBe(1);
    });

    test("cache hit when stations are reordered (sorted in cache key)", async () => {
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            calls++;
            return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
          }) as unknown as typeof fetch,
        },
      );
      await c.tableDistances(USER, [STATIONS[0]!, STATIONS[1]!, STATIONS[2]!]);
      await c.tableDistances(USER, [STATIONS[2]!, STATIONS[1]!, STATIONS[0]!]);
      expect(calls).toBe(1);
    });

    test("in-flight dedupe: parallel callers share one fetch", async () => {
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
          }) as unknown as typeof fetch,
        },
      );
      const [a, b, c2] = await Promise.all([
        c.tableDistances(USER, STATIONS),
        c.tableDistances(USER, STATIONS),
        c.tableDistances(USER, STATIONS),
      ]);
      expect(calls).toBe(1);
      expect(a).toEqual(b);
      expect(b).toEqual(c2);
    });

    test("upstream 5xx maps to OsrmError 502", async () => {
      const c = new OsrmClient({ ...baseCfg, dir }, { fetch: mockFetch("boom", 500) });
      await expect(c.tableDistances(USER, STATIONS)).rejects.toMatchObject({
        name: "OsrmError",
        status: 502,
      });
    });

    test("upstream code != Ok maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch({ code: "NoSegment", message: "no segment" }) },
      );
      await expect(c.tableDistances(USER, STATIONS)).rejects.toMatchObject({ status: 502 });
    });

    test("upstream missing matrix maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch({ code: "Ok" }) },
      );
      await expect(c.tableDistances(USER, STATIONS)).rejects.toMatchObject({ status: 502 });
    });

    test("matrix length mismatch maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch(tableBody([1000, 2000], [120, 240])) },
      );
      await expect(c.tableDistances(USER, STATIONS)).rejects.toMatchObject({ status: 502 });
    });

    test("fetch reject maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            throw new Error("ENOTFOUND");
          }) as unknown as typeof fetch,
        },
      );
      await expect(c.tableDistances(USER, STATIONS)).rejects.toMatchObject({ status: 502 });
    });

    test("includes User-Agent header on requests", async () => {
      let observedUA = "";
      const c = new OsrmClient(
        { ...baseCfg, dir, userAgent: "osrm-probe/1.0" },
        {
          fetch: (async (_url: unknown, init: unknown) => {
            const initObj = init as { headers?: Record<string, string> };
            observedUA = initObj?.headers?.["User-Agent"] ?? "";
            return new Response(JSON.stringify(tableBody([1000], [120])));
          }) as unknown as typeof fetch,
        },
      );
      await c.tableDistances(USER, [STATIONS[0]!]);
      expect(observedUA).toBe("osrm-probe/1.0");
    });

    test("TTL expiry forces a refetch", async () => {
      let now = 1_000;
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir, ttlMs: 1_000 },
        {
          now: () => now,
          fetch: (async () => {
            calls++;
            return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
          }) as unknown as typeof fetch,
        },
      );
      await c.tableDistances(USER, STATIONS);
      now += 5_000;
      await c.tableDistances(USER, STATIONS);
      expect(calls).toBe(2);
    });

    test("LRU prune removes oldest entries past cap", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir, maxEntries: 2 },
        {
          fetch: (async () =>
            new Response(JSON.stringify(tableBody([1000], [120])))) as unknown as typeof fetch,
        },
      );
      for (let i = 0; i < 5; i++) {
        await c.tableDistances({ lat: 50 + i * 0.01, lng: 13 }, [STATIONS[0]!]);
        await new Promise((r) => setTimeout(r, 10));
      }
      const files = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
      expect(files.length).toBeLessThanOrEqual(2);
    });
  });

  describe("route", () => {
    const FROM: Coord = { lat: 52.52, lng: 13.405 };
    const TO: Coord = { lat: 52.521, lng: 13.41 };
    const GEOM: [number, number][] = [
      [13.405, 52.52],
      [13.407, 52.5205],
      [13.41, 52.521],
    ];

    test("happy path: parses /route response", async () => {
      const c = new OsrmClient({ ...baseCfg, dir }, { fetch: mockFetch(routeBody(GEOM, 800, 90)) });
      const out = await c.route(FROM, TO);
      expect(out.meters).toBe(800);
      expect(out.seconds).toBe(90);
      expect(out.geometry.coordinates).toEqual(GEOM);
    });

    test("OSRM URL uses lng,lat and overview=full + geometries=geojson", async () => {
      let observedUrl = "";
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async (url: unknown) => {
            observedUrl = typeof url === "string" ? url : "";
            return new Response(JSON.stringify(routeBody(GEOM)));
          }) as unknown as typeof fetch,
        },
      );
      await c.route(FROM, TO);
      expect(observedUrl).toContain("/route/v1/driving/13.405,52.52;13.41,52.521");
      expect(observedUrl).toContain("overview=full");
      expect(observedUrl).toContain("geometries=geojson");
    });

    test("caches and dedupes parallel calls", async () => {
      let calls = 0;
      const c = new OsrmClient(
        { ...baseCfg, dir },
        {
          fetch: (async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return new Response(JSON.stringify(routeBody(GEOM)));
          }) as unknown as typeof fetch,
        },
      );
      await Promise.all([c.route(FROM, TO), c.route(FROM, TO), c.route(FROM, TO)]);
      expect(calls).toBe(1);
      await c.route(FROM, TO); // cached now
      expect(calls).toBe(1);
    });

    test("upstream 5xx maps to OsrmError 502", async () => {
      const c = new OsrmClient({ ...baseCfg, dir }, { fetch: mockFetch("boom", 500) });
      await expect(c.route(FROM, TO)).rejects.toMatchObject({ name: "OsrmError", status: 502 });
    });

    test("upstream code != Ok maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch({ code: "NoRoute" }) },
      );
      await expect(c.route(FROM, TO)).rejects.toMatchObject({ status: 502 });
    });

    test("missing geometry maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch({ code: "Ok", routes: [{ distance: 100, duration: 10 }] }) },
      );
      await expect(c.route(FROM, TO)).rejects.toMatchObject({ status: 502 });
    });

    test("malformed JSON maps to 502", async () => {
      const c = new OsrmClient(
        { ...baseCfg, dir },
        { fetch: mockFetch("<html>nope</html>") },
      );
      await expect(c.route(FROM, TO)).rejects.toMatchObject({ status: 502 });
    });
  });

  test("OsrmError carries status code + name", () => {
    const e = new OsrmError("nope", 418);
    expect(e.status).toBe(418);
    expect(e.name).toBe("OsrmError");
  });

  test("corrupt cache file falls open to a fresh fetch", async () => {
    const id = tableCacheKey(USER, STATIONS);
    await Bun.write(join(dir, `${id}.json`), "{not json");

    let calls = 0;
    const c = new OsrmClient(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          return new Response(JSON.stringify(tableBody([1000, 2000, 3000], [120, 240, 360])));
        }) as unknown as typeof fetch,
      },
    );
    await c.tableDistances(USER, STATIONS);
    expect(calls).toBe(1);
  });
});
