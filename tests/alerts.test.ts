import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Alerts } from "../src/alerts.ts";
import type { Station } from "../src/tankerkoenig.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const station = (overrides: Partial<Station> = {}): Station => ({
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
let stateFile: string;
let logs: string[];
let spawnCalls: string[][];
let webhookCalls: { url: string; body: unknown }[];

const captureLog = (msg: string) => logs.push(msg);
const captureSpawn = (cmd: string[]) => spawnCalls.push(cmd);

const webhookFetch: typeof fetch = (async (url: unknown, init: unknown) => {
  const initObj = init as { body?: string } | undefined;
  webhookCalls.push({ url: String(url), body: JSON.parse(initObj?.body ?? "{}") });
  return new Response("", { status: 204 });
}) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gas-alerts-"));
  stateFile = join(dir, "alerts-state.json");
  logs = [];
  spawnCalls = [];
  webhookCalls = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Alerts.enabled", () => {
  test("false when no thresholds configured", () => {
    const a = new Alerts({ thresholds: {}, desktopNotify: false, stateFile });
    expect(a.enabled()).toBe(false);
  });

  test("true when any threshold is set", () => {
    const a = new Alerts({ thresholds: { e10: 1.65 }, desktopNotify: false, stateFile });
    expect(a.enabled()).toBe(true);
  });
});

describe("Alerts.check", () => {
  test("fires when cheapest open price drops below threshold", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    const events = await a.check([station({ e10: 1.6 })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fuel: "e10", threshold: 1.65, price: 1.6 });
    expect(logs.some((l) => l.includes("E10 dropped"))).toBe(true);
  });

  test("does not fire when price is above threshold", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    const events = await a.check([station({ e10: 1.7 })]);
    expect(events).toHaveLength(0);
  });

  test("ignores closed stations when picking cheapest", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    const events = await a.check([
      station({ id: "open", e10: 1.7, isOpen: true }),
      station({ id: "closed", e10: 1.4, isOpen: false }),
    ]);
    expect(events).toHaveLength(0);
  });

  test("debounces: does not re-fire on subsequent checks while still below threshold", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    const first = await a.check([station({ e10: 1.6 })]);
    const second = await a.check([station({ e10: 1.58 })]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("re-fires after price climbs back above threshold and crosses below again", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    await a.check([station({ e10: 1.6 })]);
    await a.check([station({ e10: 1.7 })]);
    const third = await a.check([station({ e10: 1.6 })]);
    expect(third).toHaveLength(1);
  });

  test("invokes notify-send when desktopNotify is true", async () => {
    const a = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: true, stateFile },
      { log: captureLog, spawn: captureSpawn },
    );
    await a.check([station({ e10: 1.6 })]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe("notify-send");
  });

  test("posts to webhook URL when configured", async () => {
    const a = new Alerts(
      {
        thresholds: { e10: 1.65 },
        desktopNotify: false,
        webhookUrl: "https://example.test/hook",
        stateFile,
      },
      { log: captureLog, fetch: webhookFetch },
    );
    await a.check([station({ e10: 1.6 })]);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.url).toBe("https://example.test/hook");
    expect(webhookCalls[0]?.body).toMatchObject({ fuel: "e10", price: 1.6 });
  });

  test("persists state across instances (round-trips through disk)", async () => {
    const first = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    await first.check([station({ e10: 1.6 })]);

    const second = new Alerts(
      { thresholds: { e10: 1.65 }, desktopNotify: false, stateFile },
      { log: captureLog },
    );
    const events = await second.check([station({ e10: 1.55 })]);
    expect(events).toHaveLength(0);
  });

  test("returns empty when no thresholds are configured (short-circuits)", async () => {
    const a = new Alerts({ thresholds: {}, desktopNotify: false, stateFile });
    const events = await a.check([station({ e10: 1.5 })]);
    expect(events).toEqual([]);
  });
});
