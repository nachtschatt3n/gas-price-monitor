import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { open } from "node:fs/promises";
import type { Station } from "./tankerkoenig.ts";

export interface HistoryEntry {
  ts: number;
  stationId: string;
  name: string;
  brand: string;
  lat: number;
  lng: number;
  e5: number | false;
  e10: number | false;
  diesel: number | false;
  isOpen: boolean;
}

export interface HistoryConfig {
  dir: string;
  maxFileBytes: number;
  now?: () => number;
}

const ACTIVE_FILE = "history.jsonl";

export class History {
  private now: () => number;
  private writing = Promise.resolve();

  constructor(private cfg: HistoryConfig) {
    this.now = cfg.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true }).catch(() => {});
  }

  async append(stations: Station[]): Promise<void> {
    if (stations.length === 0) return;
    const ts = this.now();
    const lines = stations
      .map((s) => this.toEntry(s, ts))
      .filter((e): e is HistoryEntry => e !== null)
      .map((e) => JSON.stringify(e))
      .join("\n");
    if (!lines) return;

    this.writing = this.writing.then(() => this.writeLines(lines + "\n")).catch(() => {});
    await this.writing;
  }

  private toEntry(s: Station, ts: number): HistoryEntry | null {
    if (!s.id) return null;
    return {
      ts,
      stationId: s.id,
      name: s.name,
      brand: s.brand,
      lat: s.lat,
      lng: s.lng,
      e5: s.e5,
      e10: s.e10,
      diesel: s.diesel,
      isOpen: s.isOpen,
    };
  }

  private async writeLines(text: string): Promise<void> {
    const path = join(this.cfg.dir, ACTIVE_FILE);
    try {
      const s = await stat(path);
      if (s.size + text.length > this.cfg.maxFileBytes) {
        await this.rotate();
      }
    } catch {
      // file doesn't exist yet — first write
    }
    const fh = await open(path, "a");
    try {
      await fh.appendFile(text);
    } finally {
      await fh.close();
    }
  }

  private async rotate(): Promise<void> {
    const dir = this.cfg.dir;
    const active = join(dir, ACTIVE_FILE);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const rotated = entries
      .map((n) => {
        const m = n.match(/^history\.(\d+)\.jsonl$/);
        return m ? Number(m[1]) : null;
      })
      .filter((n): n is number => n !== null);
    const next = rotated.length === 0 ? 1 : Math.max(...rotated) + 1;
    await rename(active, join(dir, `history.${next}.jsonl`));
  }

  async readForStations(
    stationIds: string[],
    sinceMs: number,
  ): Promise<Map<string, { e5: HistoryPoint[]; e10: HistoryPoint[]; diesel: HistoryPoint[] }>> {
    const wanted = new Set(stationIds);
    const cutoff = this.now() - sinceMs;
    const out = new Map<string, { e5: HistoryPoint[]; e10: HistoryPoint[]; diesel: HistoryPoint[] }>();
    for (const id of stationIds) out.set(id, { e5: [], e10: [], diesel: [] });

    const files = await this.filesNewestFirst();
    for (const path of files) {
      const f = Bun.file(path);
      if (!(await f.exists())) continue;
      const text = await f.text();
      for (const line of text.split("\n")) {
        if (!line) continue;
        let entry: HistoryEntry;
        try {
          entry = JSON.parse(line) as HistoryEntry;
        } catch {
          continue;
        }
        if (!wanted.has(entry.stationId)) continue;
        if (entry.ts < cutoff) continue;
        const bucket = out.get(entry.stationId)!;
        if (typeof entry.e5 === "number" && entry.e5 > 0) bucket.e5.push({ ts: entry.ts, price: entry.e5 });
        if (typeof entry.e10 === "number" && entry.e10 > 0) bucket.e10.push({ ts: entry.ts, price: entry.e10 });
        if (typeof entry.diesel === "number" && entry.diesel > 0) bucket.diesel.push({ ts: entry.ts, price: entry.diesel });
      }
    }

    for (const bucket of out.values()) {
      bucket.e5.sort((a, b) => a.ts - b.ts);
      bucket.e10.sort((a, b) => a.ts - b.ts);
      bucket.diesel.sort((a, b) => a.ts - b.ts);
    }
    return out;
  }

  private async filesNewestFirst(): Promise<string[]> {
    const entries = await readdir(this.cfg.dir).catch(() => [] as string[]);
    const files: string[] = [];
    if (entries.includes(ACTIVE_FILE)) files.push(join(this.cfg.dir, ACTIVE_FILE));
    const rotated = entries
      .filter((n) => /^history\.\d+\.jsonl$/.test(n))
      .sort((a, b) => {
        const an = Number(a.match(/^history\.(\d+)\.jsonl$/)![1]);
        const bn = Number(b.match(/^history\.(\d+)\.jsonl$/)![1]);
        return bn - an;
      });
    for (const n of rotated) files.push(join(this.cfg.dir, n));
    return files;
  }
}

export interface HistoryPoint {
  ts: number;
  price: number;
}
