import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canonicalKey, StationCache } from "../src/cache.ts";
import type { Station } from "../src/tankerkoenig.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATION: Station = {
  id: "abc",
  name: "Aral",
  brand: "Aral",
  street: "x",
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
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gas-cache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonicalKey", () => {
  test("rounds lat/lng to 4 decimals so near-identical queries collapse", () => {
    const a = canonicalKey({ lat: 52.52, lng: 13.405, radius: 5, type: "all", sort: "dist", apiKey: "k" });
    const b = canonicalKey({ lat: 52.520012, lng: 13.405049, radius: 5, type: "all", sort: "dist", apiKey: "k" });
    expect(a).toBe(b);
  });

  test("different fuel types produce different keys", () => {
    const base = { lat: 52.52, lng: 13.405, radius: 5, sort: "dist" as const, apiKey: "k" };
    const a = canonicalKey({ ...base, type: "e5" });
    const b = canonicalKey({ ...base, type: "e10" });
    expect(a).not.toBe(b);
  });

  test("different apiKeys produce different keys (fingerprinted, not echoed)", () => {
    const base = { lat: 52.52, lng: 13.405, radius: 5, type: "all" as const, sort: "dist" as const };
    const a = canonicalKey({ ...base, apiKey: "alice" });
    const b = canonicalKey({ ...base, apiKey: "bob" });
    expect(a).not.toBe(b);
    expect(a).not.toContain("alice");
    expect(b).not.toContain("bob");
  });

  test("includes sort in key", () => {
    const base = { lat: 52.52, lng: 13.405, radius: 5, type: "e5" as const, apiKey: "k" };
    expect(canonicalKey({ ...base, sort: "dist" })).not.toBe(canonicalKey({ ...base, sort: "price" }));
  });
});

describe("StationCache", () => {
  const key = { lat: 52.52, lng: 13.405, radius: 5, type: "all" as const, sort: "dist" as const, apiKey: "k" };

  test("get returns null when nothing is cached", async () => {
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 200 });
    await cache.init();
    expect(await cache.get(key)).toBeNull();
  });

  test("getOrFetch returns fresh data and persists it", async () => {
    let now = 1_000_000;
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 200, now: () => now });
    await cache.init();

    let calls = 0;
    const entry = await cache.getOrFetch(key, async () => {
      calls++;
      return [STATION];
    });
    expect(calls).toBe(1);
    expect(entry.stations).toEqual([STATION]);

    const cached = await cache.get(key);
    expect(cached?.fetchedAt).toBe(entry.fetchedAt);
  });

  test("returns cached entry within TTL and preserves fetchedAt", async () => {
    let now = 1_000_000;
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 200, now: () => now });
    await cache.init();

    const first = await cache.getOrFetch(key, async () => [STATION]);
    now += 30_000;
    let calls = 0;
    const second = await cache.getOrFetch(key, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  test("refetches after TTL expires", async () => {
    let now = 1_000_000;
    const cache = new StationCache({ dir, ttlMs: 1_000, maxEntries: 200, now: () => now });
    await cache.init();

    await cache.getOrFetch(key, async () => [STATION]);
    now += 5_000;
    let calls = 0;
    await cache.getOrFetch(key, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);
  });

  test("in-flight dedupe: parallel callers on same key share one fetch", async () => {
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 200 });
    await cache.init();

    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return [STATION];
    };

    const [a, b, c] = await Promise.all([
      cache.getOrFetch(key, fetcher),
      cache.getOrFetch(key, fetcher),
      cache.getOrFetch(key, fetcher),
    ]);
    expect(calls).toBe(1);
    expect(a.fetchedAt).toBe(b.fetchedAt);
    expect(b.fetchedAt).toBe(c.fetchedAt);
  });

  test("LRU pruning removes oldest entries past cap", async () => {
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 3 });
    await cache.init();

    for (let i = 0; i < 6; i++) {
      const k = { ...key, lat: 52 + i * 0.1 };
      await cache.getOrFetch(k, async () => [STATION]);
      await new Promise((r) => setTimeout(r, 10));
    }

    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    expect(files.length).toBeLessThanOrEqual(3);
  });

  test("fail-open: corrupt cache file does not block fresh fetch", async () => {
    const cache = new StationCache({ dir, ttlMs: 60_000, maxEntries: 200 });
    await cache.init();

    const id = canonicalKey(key);
    await Bun.write(join(dir, `${id}.json`), "{not json");

    const entry = await cache.getOrFetch(key, async () => [STATION]);
    expect(entry.stations).toEqual([STATION]);
  });
});
