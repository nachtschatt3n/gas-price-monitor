import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { History } from "../src/history.ts";
import type { Station } from "../src/tankerkoenig.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseStation = (overrides: Partial<Station> = {}): Station => ({
  id: "s1",
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
  ...overrides,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gas-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("History.append + readForStations", () => {
  test("appends JSONL lines and reads them back", async () => {
    const now = 2_000_000_000_000;
    const history = new History({ dir, maxFileBytes: 1024 * 1024, now: () => now });
    await history.init();

    await history.append([baseStation({ id: "s1" }), baseStation({ id: "s2", e10: 1.799 })]);

    const result = await history.readForStations(["s1", "s2"], 60_000);
    expect(result.get("s1")?.e10).toEqual([{ ts: now, price: 1.749 }]);
    expect(result.get("s2")?.e10).toEqual([{ ts: now, price: 1.799 }]);
  });

  test("ignores entries outside the sinceMs window", async () => {
    let now = 1_000;
    const history = new History({ dir, maxFileBytes: 1024 * 1024, now: () => now });
    await history.init();

    await history.append([baseStation({ id: "s1" })]);
    now += 200_000;
    await history.append([baseStation({ id: "s1", e10: 1.7 })]);

    const result = await history.readForStations(["s1"], 100_000);
    expect(result.get("s1")?.e10).toEqual([{ ts: 201_000, price: 1.7 }]);
  });

  test("skips stations with no id and prices of `false`", async () => {
    const history = new History({ dir, maxFileBytes: 1024 * 1024 });
    await history.init();

    await history.append([
      baseStation({ id: "", name: "no-id" }),
      baseStation({ id: "s1", e5: false, e10: 1.7, diesel: false }),
    ]);

    const result = await history.readForStations(["s1"], 60_000);
    expect(result.get("s1")?.e5).toEqual([]);
    expect(result.get("s1")?.diesel).toEqual([]);
    expect(result.get("s1")?.e10).toHaveLength(1);
  });

  test("rotates the file when size cap is exceeded", async () => {
    const history = new History({ dir, maxFileBytes: 200 });
    await history.init();

    // First batch fits.
    await history.append([baseStation({ id: "s1" })]);
    // Each subsequent batch will likely trigger rotation because lines are ~150B.
    await history.append([baseStation({ id: "s2" }), baseStation({ id: "s3" })]);
    await history.append([baseStation({ id: "s4" })]);

    const files = (await readdir(dir)).filter((n) => /^history(\.\d+)?\.jsonl$/.test(n));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain("history.jsonl");
  });

  test("ignores malformed JSON lines instead of crashing", async () => {
    const history = new History({ dir, maxFileBytes: 1024 * 1024 });
    await history.init();
    await history.append([baseStation({ id: "s1" })]);

    // Corrupt the file with a garbage line.
    const path = join(dir, "history.jsonl");
    const current = await Bun.file(path).text();
    await Bun.write(path, current + "{not json\n");

    const result = await history.readForStations(["s1"], 60_000);
    expect(result.get("s1")?.e10).toHaveLength(1);
  });

  test("returns empty buckets for stations with no recorded data", async () => {
    const history = new History({ dir, maxFileBytes: 1024 * 1024 });
    await history.init();

    const result = await history.readForStations(["never-seen"], 60_000);
    expect(result.get("never-seen")).toEqual({ e5: [], e10: [], diesel: [] });
  });
});
