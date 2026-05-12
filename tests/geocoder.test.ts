import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Geocoder, canonicalize, cacheKey, parseFeature, GeocoderError } from "../src/geocoder.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEATURE_BERLIN_HBF = {
  type: "Feature",
  properties: {
    name: "Berlin Hauptbahnhof",
    street: "Europaplatz",
    housenumber: "1",
    city: "Berlin",
    state: "Berlin",
    country: "Deutschland",
    postcode: "10557",
  },
  geometry: { type: "Point", coordinates: [13.3696614, 52.5249451] },
};

const FEATURE_STUTTGART = {
  type: "Feature",
  properties: {
    name: "Stuttgart",
    state: "Baden-Württemberg",
    country: "Deutschland",
  },
  geometry: { type: "Point", coordinates: [9.1800132, 48.7784485] },
};

function mockFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gas-geocoder-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonicalize", () => {
  test("trims, collapses whitespace, lowercases", () => {
    expect(canonicalize("  Berlin  Hauptbahnhof  ")).toBe("berlin hauptbahnhof");
    expect(canonicalize("BERLIN")).toBe("berlin");
    expect(canonicalize("Stutt\tgart\n")).toBe("stutt gart");
  });

  test("preserves diacritics and ß (Photon distinguishes them)", () => {
    expect(canonicalize("Straße")).toBe("straße");
    expect(canonicalize("München")).toBe("münchen");
    expect(canonicalize("Strasse")).not.toBe(canonicalize("Straße"));
  });
});

describe("cacheKey", () => {
  test("normalizes equivalent inputs to the same key", () => {
    expect(cacheKey("  Berlin Mitte ")).toBe(cacheKey("BERLIN MITTE"));
    expect(cacheKey("berlin\tmitte")).toBe(cacheKey("berlin mitte"));
  });

  test("different queries produce different keys", () => {
    expect(cacheKey("Berlin")).not.toBe(cacheKey("Stuttgart"));
  });

  test("does not leak the raw query", () => {
    const k = cacheKey("supersecret-location");
    expect(k).not.toContain("supersecret");
    expect(k).toHaveLength(24);
  });
});

describe("parseFeature", () => {
  test("Berlin Hauptbahnhof: name + city, lat/lng decoded correctly", () => {
    const r = parseFeature(FEATURE_BERLIN_HBF);
    expect(r).toEqual({
      label: "Berlin Hauptbahnhof, Berlin",
      lat: 52.5249451,
      lng: 13.3696614,
    });
  });

  test("city name alone falls back to state suffix", () => {
    const r = parseFeature(FEATURE_STUTTGART);
    expect(r).toEqual({
      label: "Stuttgart, Baden-Württemberg",
      lat: 48.7784485,
      lng: 9.1800132,
    });
  });

  test("street-only feature builds street + housenumber + city label", () => {
    const r = parseFeature({
      properties: { street: "Hauptstraße", housenumber: "42", city: "Berlin" },
      geometry: { coordinates: [13.4, 52.5] },
    });
    expect(r?.label).toBe("Hauptstraße 42, Berlin");
  });

  test("returns null on missing coordinates", () => {
    expect(parseFeature({ properties: { name: "X" } })).toBeNull();
    expect(parseFeature({ geometry: {}, properties: { name: "X" } })).toBeNull();
  });

  test("returns null on out-of-range coordinates", () => {
    expect(
      parseFeature({
        properties: { name: "X" },
        geometry: { coordinates: [200, 100] },
      }),
    ).toBeNull();
  });

  test("returns null when no label can be built", () => {
    expect(
      parseFeature({
        properties: {},
        geometry: { coordinates: [13.4, 52.5] },
      }),
    ).toBeNull();
  });

  test("truncates long labels with ellipsis", () => {
    const r = parseFeature({
      properties: { name: "X".repeat(80), city: "Y".repeat(20) },
      geometry: { coordinates: [13.4, 52.5] },
    });
    expect(r?.label.length).toBeLessThanOrEqual(60);
    expect(r?.label).toMatch(/…$/);
  });
});

describe("Geocoder", () => {
  const baseCfg = {
    baseUrl: "https://photon.test",
    userAgent: "gas-price-monitor (test)",
    ttlMs: 60_000,
    maxEntries: 200,
    lang: "de",
    limit: 5,
  };

  test("empty query short-circuits without hitting upstream", async () => {
    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(await g.geocode("  ")).toEqual([]);
    expect(calls).toBe(0);
  });

  test("happy path: parses Photon FeatureCollection and caches the result", async () => {
    const body = { type: "FeatureCollection", features: [FEATURE_BERLIN_HBF, FEATURE_STUTTGART] };
    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );

    const first = await g.geocode("Berlin");
    expect(first).toHaveLength(2);
    expect(first[0]?.label).toBe("Berlin Hauptbahnhof, Berlin");
    expect(calls).toBe(1);

    const second = await g.geocode("Berlin");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("canonicalization collapses near-identical queries onto the same cache entry", async () => {
    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          return new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );

    await g.geocode("Berlin Mitte");
    await g.geocode("  berlin  mitte  ");
    await g.geocode("BERLIN MITTE");
    expect(calls).toBe(1);
  });

  test("in-flight dedupe: parallel callers share one fetch", async () => {
    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          return new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );
    const [a, b, c] = await Promise.all([
      g.geocode("Berlin"),
      g.geocode("Berlin"),
      g.geocode("berlin"),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test("upstream 5xx maps to GeocoderError 502", async () => {
    const g = new Geocoder({ ...baseCfg, dir }, { fetch: mockFetch("boom", 500) });
    await expect(g.geocode("Berlin")).rejects.toMatchObject({
      name: "GeocoderError",
      status: 502,
    });
  });

  test("malformed JSON maps to 502", async () => {
    const g = new Geocoder(
      { ...baseCfg, dir },
      { fetch: mockFetch("<html>not json</html>") },
    );
    await expect(g.geocode("Berlin")).rejects.toMatchObject({ status: 502 });
  });

  test("fetch reject maps to 502", async () => {
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          throw new Error("ENOTFOUND");
        }) as unknown as typeof fetch,
      },
    );
    await expect(g.geocode("Berlin")).rejects.toMatchObject({ status: 502 });
  });

  test("corrupt cache file falls open to a fresh fetch", async () => {
    const id = cacheKey("Berlin");
    await Bun.write(join(dir, `${id}.json`), "{not json");

    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir },
      {
        fetch: (async () => {
          calls++;
          return new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );
    const results = await g.geocode("Berlin");
    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
  });

  test("TTL expiry forces a refetch", async () => {
    let now = 1_000;
    let calls = 0;
    const g = new Geocoder(
      { ...baseCfg, dir, ttlMs: 1_000 },
      {
        now: () => now,
        fetch: (async () => {
          calls++;
          return new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );
    await g.geocode("Berlin");
    now += 5_000;
    await g.geocode("Berlin");
    expect(calls).toBe(2);
  });

  test("LRU prune removes oldest entries past cap", async () => {
    const g = new Geocoder(
      { ...baseCfg, dir, maxEntries: 3 },
      {
        fetch: (async () =>
          new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
    );
    for (const q of ["a", "b", "c", "d", "e"]) {
      await g.geocode(q);
      await new Promise((r) => setTimeout(r, 10));
    }
    const files = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    expect(files.length).toBeLessThanOrEqual(3);
  });

  test("respects limit when upstream returns more features than asked", async () => {
    const features = Array.from({ length: 10 }, (_, i) => ({
      properties: { name: `Place${i}`, city: `City${i}` },
      geometry: { coordinates: [13.4, 52.5] },
    }));
    const g = new Geocoder(
      { ...baseCfg, dir, limit: 3 },
      {
        fetch: mockFetch({ type: "FeatureCollection", features }),
      },
    );
    const results = await g.geocode("anything");
    expect(results).toHaveLength(3);
  });

  test("includes User-Agent header on requests", async () => {
    let observedUA = "";
    const g = new Geocoder(
      { ...baseCfg, dir, userAgent: "test-ua/1.0 (probe)" },
      {
        fetch: (async (_url: unknown, init: unknown) => {
          const initObj = init as { headers?: Record<string, string> };
          observedUA = initObj?.headers?.["User-Agent"] ?? "";
          return new Response(
            JSON.stringify({ type: "FeatureCollection", features: [FEATURE_BERLIN_HBF] }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );
    await g.geocode("Berlin");
    expect(observedUA).toBe("test-ua/1.0 (probe)");
  });

  test("GeocoderError carries status code", () => {
    const e = new GeocoderError("nope", 418);
    expect(e.status).toBe(418);
    expect(e.name).toBe("GeocoderError");
  });
});
