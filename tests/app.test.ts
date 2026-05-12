import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, parseEnv, ValidationError } from "../src/app.ts";
import type { AppEnv } from "../src/app.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATION_BODY = {
  ok: true,
  stations: [
    {
      id: "abc",
      name: "Aral",
      brand: "Aral",
      street: "Hauptstr",
      houseNumber: "1",
      postCode: 10115,
      place: "Berlin",
      lat: 52.5,
      lng: 13.4,
      dist: 1.2,
      isOpen: true,
      e5: 1.789,
      e10: 1.749,
      diesel: 1.659,
    },
  ],
};

let cacheDir: string;
let publicDir: string;
let dataDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "gas-cache-"));
  publicDir = await mkdtemp(join(tmpdir(), "gas-public-"));
  dataDir = await mkdtemp(join(tmpdir(), "gas-data-"));
  await Bun.write(join(publicDir, "index.html"), "<!doctype html><h1>hi</h1>");
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  await rm(publicDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    apiKey: "test-key",
    defaultLat: 52.52,
    defaultLng: 13.405,
    defaultRadius: 5,
    publicDir,
    cacheDir,
    cacheTtlMs: 60_000,
    cacheMaxEntries: 200,
    dataDir,
    historyMaxFileBytes: 1024 * 1024,
    alertThresholds: {},
    alertDesktopNotify: false,
    photonUserAgent: "gas-price-monitor (test)",
    photonBaseUrl: "https://photon.test",
    geocodeCacheTtlMs: 60_000,
    geocodeCacheMaxEntries: 200,
    osrmUserAgent: "gas-price-monitor (test)",
    osrmBaseUrl: "https://osrm.test",
    osrmCacheTtlMs: 60_000,
    osrmCacheMaxEntries: 200,
    stadiaApiKey: "",
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const req = new Request(`http://localhost${path}`, init);
  const url = new URL(req.url);
  const route = (app.routes as Record<string, Record<string, (r: Request) => Response | Promise<Response>>>)[
    url.pathname
  ];
  if (route) {
    const handler = route[method];
    if (!handler) return new Response("method not allowed", { status: 405 });
    return await handler(req);
  }
  return await app.fetch(req);
}

const MIN_ENV = {
  PHOTON_USER_AGENT: "gas-price-monitor (test)",
  OSRM_USER_AGENT: "gas-price-monitor (test)",
};

describe("parseEnv", () => {
  test("returns defaults when only required env is set", () => {
    const result = parseEnv(MIN_ENV, "/pub", "/cache", "/data");
    expect(result).toMatchObject({
      apiKey: "",
      defaultLat: 52.52,
      defaultLng: 13.405,
      defaultRadius: 5,
      cacheTtlMs: 5 * 60 * 1000,
      alertThresholds: {},
      alertDesktopNotify: false,
      photonUserAgent: "gas-price-monitor (test)",
      photonBaseUrl: "https://photon.komoot.io",
      geocodeCacheTtlMs: 24 * 60 * 60 * 1000,
      geocodeCacheMaxEntries: 200,
      osrmUserAgent: "gas-price-monitor (test)",
      osrmBaseUrl: "https://router.project-osrm.org",
      osrmCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
      osrmCacheMaxEntries: 500,
      stadiaApiKey: "",
    });
  });

  test("PHOTON_USER_AGENT is required (throws when missing)", () => {
    expect(() => parseEnv({ OSRM_USER_AGENT: "x" }, "/p", "/c", "/d")).toThrow(/PHOTON_USER_AGENT/);
    expect(() => parseEnv({ PHOTON_USER_AGENT: "", OSRM_USER_AGENT: "x" }, "/p", "/c", "/d")).toThrow(/PHOTON_USER_AGENT/);
    expect(() => parseEnv({ PHOTON_USER_AGENT: "   ", OSRM_USER_AGENT: "x" }, "/p", "/c", "/d")).toThrow(/PHOTON_USER_AGENT/);
  });

  test("OSRM_USER_AGENT is required (throws when missing)", () => {
    expect(() => parseEnv({ PHOTON_USER_AGENT: "x" }, "/p", "/c", "/d")).toThrow(/OSRM_USER_AGENT/);
    expect(() => parseEnv({ PHOTON_USER_AGENT: "x", OSRM_USER_AGENT: "  " }, "/p", "/c", "/d")).toThrow(/OSRM_USER_AGENT/);
  });

  test("OSRM_BASE_URL strips trailing slash", () => {
    const result = parseEnv(
      { ...MIN_ENV, OSRM_BASE_URL: "https://osrm.example.com/" },
      "/p",
      "/c",
      "/d",
    );
    expect(result.osrmBaseUrl).toBe("https://osrm.example.com");
  });

  test("STADIA_API_KEY is optional and trimmed", () => {
    const empty = parseEnv(MIN_ENV, "/p", "/c", "/d");
    expect(empty.stadiaApiKey).toBe("");
    const set = parseEnv({ ...MIN_ENV, STADIA_API_KEY: "  my-key  " }, "/p", "/c", "/d");
    expect(set.stadiaApiKey).toBe("my-key");
  });

  test("PHOTON_BASE_URL strips trailing slash", () => {
    const result = parseEnv(
      { ...MIN_ENV, PHOTON_BASE_URL: "https://photon.example.com/" },
      "/p",
      "/c",
      "/d",
    );
    expect(result.photonBaseUrl).toBe("https://photon.example.com");
  });

  test("rejects invalid DEFAULT_LAT (NaN, out of range)", () => {
    expect(() => parseEnv({ ...MIN_ENV, DEFAULT_LAT: "not-a-number" }, "/p", "/c", "/d")).toThrow(/DEFAULT_LAT/);
    expect(() => parseEnv({ ...MIN_ENV, DEFAULT_LAT: "200" }, "/p", "/c", "/d")).toThrow(/DEFAULT_LAT/);
  });

  test("rejects invalid DEFAULT_RADIUS (out of [1,25])", () => {
    expect(() => parseEnv({ ...MIN_ENV, DEFAULT_RADIUS: "100" }, "/p", "/c", "/d")).toThrow(/DEFAULT_RADIUS/);
    expect(() => parseEnv({ ...MIN_ENV, DEFAULT_RADIUS: "0" }, "/p", "/c", "/d")).toThrow(/DEFAULT_RADIUS/);
  });

  test("rejects invalid GEOCODE_CACHE_TTL_MS", () => {
    expect(() =>
      parseEnv({ ...MIN_ENV, GEOCODE_CACHE_TTL_MS: "0" }, "/p", "/c", "/d"),
    ).toThrow(/GEOCODE_CACHE_TTL_MS/);
  });

  test("parses alert thresholds when set", () => {
    const result = parseEnv(
      { ...MIN_ENV, ALERT_E10_BELOW: "1.65", ALERT_DIESEL_BELOW: "1.55", ALERT_DESKTOP_NOTIFY: "true" },
      "/p",
      "/c",
      "/d",
    );
    expect(result.alertThresholds).toEqual({ e10: 1.65, diesel: 1.55 });
    expect(result.alertDesktopNotify).toBe(true);
  });

  test("rejects invalid alert threshold", () => {
    expect(() => parseEnv({ ...MIN_ENV, ALERT_E5_BELOW: "not-a-number" }, "/p", "/c", "/d")).toThrow(/ALERT_E5_BELOW/);
  });
});

describe("/api/config", () => {
  test("returns defaults and hasApiKey=true", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      defaultLat: 52.52,
      defaultLng: 13.405,
      defaultRadius: 5,
      hasApiKey: true,
      alertsEnabled: false,
    });
  });

  test("returns hasApiKey=false when key is empty", async () => {
    const app = createApp(env({ apiKey: "" }), { fetch: mockFetch(STATION_BODY) });
    const body = (await (await call(app, "GET", "/api/config")).json()) as { hasApiKey: boolean };
    expect(body.hasApiKey).toBe(false);
  });

  test("reflects Stadia + OSRM flags", async () => {
    const withStadia = createApp(env({ stadiaApiKey: "abc-123" }), { fetch: mockFetch(STATION_BODY) });
    const cfg = (await (await call(withStadia, "GET", "/api/config")).json()) as {
      hasStadiaKey: boolean;
      stadiaApiKey: string;
      osrmEnabled: boolean;
    };
    expect(cfg.hasStadiaKey).toBe(true);
    expect(cfg.stadiaApiKey).toBe("abc-123");
    expect(cfg.osrmEnabled).toBe(true);

    const noStadia = createApp(env({ stadiaApiKey: "" }), { fetch: mockFetch(STATION_BODY) });
    const cfg2 = (await (await call(noStadia, "GET", "/api/config")).json()) as {
      hasStadiaKey: boolean;
      stadiaApiKey: string;
    };
    expect(cfg2.hasStadiaKey).toBe(false);
    expect(cfg2.stadiaApiKey).toBe("");
  });
});

describe("/api/stations", () => {
  test("happy path returns stations + fetchedAt", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/stations?lat=52.5&lng=13.4&radius=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stations: unknown[]; fetchedAt: string };
    expect(body.stations).toHaveLength(1);
    expect(body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("rejects invalid radius with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/stations?radius=999");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/radius/);
  });

  test("rejects invalid lat with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/stations?lat=200");
    expect(res.status).toBe(400);
  });

  test("rejects invalid fuel type with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/stations?type=xyz");
    expect(res.status).toBe(400);
  });

  test("returns 500 when apiKey is missing", async () => {
    const app = createApp(env({ apiKey: "" }), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/stations");
    expect(res.status).toBe(500);
  });

  test("upstream 5xx maps to 502", async () => {
    const app = createApp(env(), { fetch: mockFetch("boom", 500) });
    const res = await call(app, "GET", "/api/stations");
    expect(res.status).toBe(502);
  });

  test("cache hit on second call within TTL (single upstream fetch)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(STATION_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const app = createApp(env(), { fetch: fetchImpl });

    const first = await (await call(app, "GET", "/api/stations?lat=52.5&lng=13.4&radius=5")).json() as { fetchedAt: string };
    const second = await (await call(app, "GET", "/api/stations?lat=52.5&lng=13.4&radius=5")).json() as { fetchedAt: string };

    expect(calls).toBe(1);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });
});

describe("static serving", () => {
  test("GET / serves index.html", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>hi</h1>");
  });

  test("blocks ../ path traversal", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/%2e%2e/etc/passwd");
    expect(res.status).toBe(404);
  });

  test("returns 405 on POST /unknown", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "POST", "/index.html");
    expect(res.status).toBe(405);
  });

  test("returns 404 for missing files", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/nope.html");
    expect(res.status).toBe(404);
  });
});

describe("/api/history", () => {
  test("rejects missing stationIds with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/history");
    expect(res.status).toBe(400);
  });

  test("rejects more than 50 stationIds", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `s${i}`).join(",");
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", `/api/history?stationIds=${ids}`);
    expect(res.status).toBe(400);
  });

  test("returns empty buckets for unknown stationIds", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    const res = await call(app, "GET", "/api/history?stationIds=never-seen");
    expect(res.status).toBe(200);
    type Buckets = { e5: unknown[]; e10: unknown[]; diesel: unknown[] };
    const body = (await res.json()) as { stations: Record<string, Buckets> };
    expect(body.stations["never-seen"]).toEqual({ e5: [], e10: [], diesel: [] });
  });

  test("returns recorded history after a cache miss writes it", async () => {
    const app = createApp(env(), { fetch: mockFetch(STATION_BODY) });
    await call(app, "GET", "/api/stations?lat=52.5&lng=13.4&radius=5");
    // Give the async history append a tick to settle.
    await new Promise((r) => setTimeout(r, 30));

    const res = await call(app, "GET", "/api/history?stationIds=abc&days=1");
    type Buckets = { e5: { ts: number; price: number }[]; e10: { ts: number; price: number }[]; diesel: { ts: number; price: number }[] };
    const body = (await res.json()) as { stations: Record<string, Buckets> };
    const bucket = body.stations["abc"];
    expect(bucket).toBeDefined();
    expect(bucket!.e10).toHaveLength(1);
    expect(bucket!.e10[0]?.price).toBe(1.749);
  });
});

describe("alerts integration", () => {
  test("fires alert when stations come back below threshold", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          stations: [{ ...STATION_BODY.stations[0], e10: 1.5 }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const events: unknown[] = [];
    const app = createApp(
      env({ alertThresholds: { e10: 1.6 } }),
      {
        fetch: fetchImpl,
        alertDeps: { log: (m: string) => events.push(m) },
      },
    );
    await call(app, "GET", "/api/stations?lat=52.5&lng=13.4&radius=5");
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => String(e).includes("E10 dropped"))).toBe(true);
  });
});

describe("/api/geocode", () => {
  const PHOTON_BODY = {
    type: "FeatureCollection",
    features: [
      {
        properties: { name: "Berlin Hauptbahnhof", city: "Berlin" },
        geometry: { coordinates: [13.3696614, 52.5249451] },
      },
      {
        properties: { name: "Berlin", state: "Berlin" },
        geometry: { coordinates: [13.4, 52.52] },
      },
    ],
  };

  test("rejects empty q with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(PHOTON_BODY) });
    const res = await call(app, "GET", "/api/geocode?q=");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid query/);
  });

  test("rejects 1-char q with 400 (after canonicalization)", async () => {
    const app = createApp(env(), { fetch: mockFetch(PHOTON_BODY) });
    const res = await call(app, "GET", "/api/geocode?q=%20%20a%20%20");
    expect(res.status).toBe(400);
  });

  test("rejects 201-char q with 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(PHOTON_BODY) });
    const long = "A".repeat(201);
    const res = await call(app, "GET", `/api/geocode?q=${encodeURIComponent(long)}`);
    expect(res.status).toBe(400);
  });

  test("happy path: returns parsed results", async () => {
    const app = createApp(env(), { fetch: mockFetch(PHOTON_BODY) });
    const res = await call(app, "GET", "/api/geocode?q=Berlin");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { label: string; lat: number; lng: number }[] };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      label: "Berlin Hauptbahnhof, Berlin",
      lat: 52.5249451,
      lng: 13.3696614,
    });
  });

  test("upstream 5xx maps to 502 with friendly error message", async () => {
    const app = createApp(env(), { fetch: mockFetch("broken", 500) });
    const res = await call(app, "GET", "/api/geocode?q=Berlin");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("geocoder unavailable");
  });

  test("no-result query returns 200 with empty results", async () => {
    const app = createApp(env(), {
      fetch: mockFetch({ type: "FeatureCollection", features: [] }),
    });
    const res = await call(app, "GET", "/api/geocode?q=Asdfghjkl");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([]);
  });

  test("second identical query within TTL hits the cache (1 upstream call)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(PHOTON_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const app = createApp(env(), { fetch: fetchImpl });
    await call(app, "GET", "/api/geocode?q=Berlin");
    await call(app, "GET", "/api/geocode?q=Berlin");
    expect(calls).toBe(1);
  });

  test("canonicalization collapses near-identical queries onto same cache entry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(PHOTON_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const app = createApp(env(), { fetch: fetchImpl });
    await call(app, "GET", "/api/geocode?q=Berlin");
    await call(app, "GET", "/api/geocode?q=%20%20BERLIN%20%20");
    await call(app, "GET", "/api/geocode?q=berlin");
    expect(calls).toBe(1);
  });
});

describe("ValidationError", () => {
  test("carries default status 400", () => {
    const err = new ValidationError("bad");
    expect(err.status).toBe(400);
  });
});

const TABLE_BODY = {
  code: "Ok",
  distances: [[1000, 2000, 3000]],
  durations: [[120, 240, 360]],
};

const ROUTE_BODY = {
  code: "Ok",
  routes: [
    {
      geometry: {
        type: "LineString",
        coordinates: [
          [13.405, 52.52],
          [13.41, 52.521],
        ],
      },
      distance: 800,
      duration: 90,
    },
  ],
};

describe("/api/distances", () => {
  test("happy path: returns id-keyed distance map", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations: [
        { id: "s1", lat: 52.521, lng: 13.41 },
        { id: "s2", lat: 52.519, lng: 13.39 },
        { id: "s3", lat: 52.52, lng: 13.42 },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { distances: Record<string, { meters: number }> };
    expect(body.distances.s1?.meters).toBe(1000);
    expect(body.distances.s2?.meters).toBe(2000);
    expect(body.distances.s3?.meters).toBe(3000);
  });

  test("rejects invalid JSON body", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", "{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON/i);
  });

  test("rejects missing userLat/userLng", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      stations: [{ id: "s1", lat: 52.5, lng: 13.4 }],
    });
    expect(res.status).toBe(400);
  });

  test("rejects out-of-range user coords", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 200,
      userLng: 13.4,
      stations: [{ id: "s1", lat: 52.5, lng: 13.4 }],
    });
    expect(res.status).toBe(400);
  });

  test("empty stations array returns empty distances (no upstream)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(TABLE_BODY));
    }) as unknown as typeof fetch;
    const app = createApp(env(), { fetch: fetchImpl });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations: [],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { distances: object }).distances).toEqual({});
    expect(calls).toBe(0);
  });

  test("rejects > 50 stations (Default #16 cap)", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const stations = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      lat: 52.5,
      lng: 13.4,
    }));
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/max 50/i);
  });

  test("rejects station without id", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations: [{ lat: 52.5, lng: 13.4 }],
    });
    expect(res.status).toBe(400);
  });

  test("rejects station with bad coords", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations: [{ id: "s1", lat: "wat", lng: 13.4 }],
    });
    expect(res.status).toBe(400);
  });

  test("upstream 5xx maps to 502 'routing unavailable'", async () => {
    const app = createApp(env(), { fetch: mockFetch("boom", 500) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
      stations: [{ id: "s1", lat: 52.521, lng: 13.41 }],
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("routing unavailable");
  });

  test("stations array missing returns 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(TABLE_BODY) });
    const res = await call(app, "POST", "/api/distances", {
      userLat: 52.52,
      userLng: 13.405,
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/route", () => {
  test("happy path: returns geometry + meters + seconds", async () => {
    const app = createApp(env(), { fetch: mockFetch(ROUTE_BODY) });
    const res = await call(
      app,
      "GET",
      "/api/route?fromLat=52.52&fromLng=13.405&toLat=52.521&toLng=13.41",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meters: number;
      seconds: number;
      geometry: { coordinates: unknown[] };
    };
    expect(body.meters).toBe(800);
    expect(body.seconds).toBe(90);
    expect(body.geometry.coordinates).toHaveLength(2);
  });

  test("missing coords returns 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(ROUTE_BODY) });
    const res = await call(app, "GET", "/api/route?fromLat=52.52&fromLng=13.405");
    expect(res.status).toBe(400);
  });

  test("NaN coords return 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(ROUTE_BODY) });
    const res = await call(
      app,
      "GET",
      "/api/route?fromLat=hi&fromLng=13.405&toLat=52.521&toLng=13.41",
    );
    expect(res.status).toBe(400);
  });

  test("out-of-range coords return 400", async () => {
    const app = createApp(env(), { fetch: mockFetch(ROUTE_BODY) });
    const res = await call(
      app,
      "GET",
      "/api/route?fromLat=999&fromLng=13.405&toLat=52.521&toLng=13.41",
    );
    expect(res.status).toBe(400);
  });

  test("from == to returns 400 'same point' (Default #26)", async () => {
    const app = createApp(env(), { fetch: mockFetch(ROUTE_BODY) });
    const res = await call(
      app,
      "GET",
      "/api/route?fromLat=52.52&fromLng=13.405&toLat=52.52&toLng=13.405",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/same point/i);
  });

  test("upstream 5xx maps to 502", async () => {
    const app = createApp(env(), { fetch: mockFetch("nope", 500) });
    const res = await call(
      app,
      "GET",
      "/api/route?fromLat=52.52&fromLng=13.405&toLat=52.521&toLng=13.41",
    );
    expect(res.status).toBe(502);
  });
});
