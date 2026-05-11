import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Station, FuelType } from "./tankerkoenig.ts";

export interface AlertThresholds {
  e5?: number;
  e10?: number;
  diesel?: number;
}

export interface AlertConfig {
  thresholds: AlertThresholds;
  webhookUrl?: string;
  desktopNotify: boolean;
  stateFile: string;
  now?: () => number;
}

export interface AlertDeps {
  fetch?: typeof globalThis.fetch;
  spawn?: (cmd: string[]) => void;
  log?: (msg: string) => void;
}

interface AlertState {
  lastBelowE5?: number;
  lastBelowE10?: number;
  lastBelowDiesel?: number;
}

export interface AlertEvent {
  fuel: FuelType;
  threshold: number;
  price: number;
  stationId: string;
  stationName: string;
  brand: string;
}

const FUELS: FuelType[] = ["e5", "e10", "diesel"];

export class Alerts {
  private state: AlertState = {};
  private loaded = false;
  private now: () => number;

  constructor(private cfg: AlertConfig, private deps: AlertDeps = {}) {
    this.now = cfg.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.cfg.stateFile), { recursive: true }).catch(() => {});
    try {
      const f = Bun.file(this.cfg.stateFile);
      if (await f.exists()) {
        this.state = (await f.json()) as AlertState;
      }
    } catch {
      this.state = {};
    }
    this.loaded = true;
  }

  enabled(): boolean {
    return (
      this.cfg.thresholds.e5 !== undefined ||
      this.cfg.thresholds.e10 !== undefined ||
      this.cfg.thresholds.diesel !== undefined
    );
  }

  async check(stations: Station[]): Promise<AlertEvent[]> {
    if (!this.enabled()) return [];
    if (!this.loaded) await this.init();

    const events: AlertEvent[] = [];

    for (const fuel of FUELS) {
      const threshold = this.cfg.thresholds[fuel];
      if (threshold === undefined) continue;

      const cheapest = pickCheapest(stations, fuel);
      const stateKey = stateKeyFor(fuel);
      const prev = this.state[stateKey];

      if (!cheapest) continue;

      const isBelow = cheapest.price < threshold;
      const wasBelow = prev !== undefined && prev < threshold;

      if (isBelow && !wasBelow) {
        events.push({
          fuel,
          threshold,
          price: cheapest.price,
          stationId: cheapest.stationId,
          stationName: cheapest.name,
          brand: cheapest.brand,
        });
      }

      this.state[stateKey] = cheapest.price;
    }

    if (events.length > 0) await this.dispatch(events);
    await this.persistState();
    return events;
  }

  private async dispatch(events: AlertEvent[]): Promise<void> {
    const log = this.deps.log ?? console.log;
    for (const e of events) {
      const msg = `[alert] ${e.fuel.toUpperCase()} dropped to ${e.price.toFixed(3)} € at ${e.brand} ${e.stationName} (threshold ${e.threshold.toFixed(3)} €)`;
      log(msg);

      if (this.cfg.desktopNotify) {
        const spawn = this.deps.spawn ?? defaultSpawn;
        try {
          spawn(["notify-send", "Gas Price Alert", msg]);
        } catch {
          // ignore — desktop may not have notify-send
        }
      }

      if (this.cfg.webhookUrl) {
        const fetchImpl = this.deps.fetch ?? globalThis.fetch;
        try {
          await fetchImpl(this.cfg.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...e, ts: this.now() }),
          });
        } catch {
          // best-effort — never fail the upstream request because of a webhook failure
        }
      }
    }
  }

  private async persistState(): Promise<void> {
    try {
      await Bun.write(this.cfg.stateFile, JSON.stringify(this.state));
    } catch {
      // best-effort
    }
  }
}

function stateKeyFor(fuel: FuelType): keyof AlertState {
  if (fuel === "e5") return "lastBelowE5";
  if (fuel === "e10") return "lastBelowE10";
  return "lastBelowDiesel";
}

function pickCheapest(
  stations: Station[],
  fuel: FuelType,
): { price: number; stationId: string; name: string; brand: string } | null {
  let best: { price: number; stationId: string; name: string; brand: string } | null = null;
  for (const s of stations) {
    if (!s.isOpen) continue;
    const p = s[fuel];
    if (typeof p !== "number" || p <= 0) continue;
    if (!best || p < best.price) {
      best = { price: p, stationId: s.id, name: s.name, brand: s.brand };
    }
  }
  return best;
}

function defaultSpawn(cmd: string[]): void {
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignore
  }
}
