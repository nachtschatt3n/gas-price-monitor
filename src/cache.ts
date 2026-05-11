import { mkdir, rename, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Station, RequestedFuel } from "./tankerkoenig.ts";

export interface CacheEntry {
  fetchedAt: string;
  stations: Station[];
}

export interface CacheKey {
  lat: number;
  lng: number;
  radius: number;
  type: RequestedFuel;
  sort: "dist" | "price";
  apiKey: string;
}

export interface CacheConfig {
  dir: string;
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export function canonicalKey(k: CacheKey): string {
  const lat = round4(k.lat);
  const lng = round4(k.lng);
  const radius = Math.round(k.radius);
  const apiKeyFp = createHash("sha256").update(k.apiKey).digest("hex").slice(0, 8);
  const raw = `${lat}|${lng}|${radius}|${k.type}|${k.sort}|${apiKeyFp}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class StationCache {
  private inflight = new Map<string, Promise<CacheEntry>>();
  private now: () => number;

  constructor(private cfg: CacheConfig) {
    this.now = cfg.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true }).catch(() => {});
  }

  async get(key: CacheKey): Promise<CacheEntry | null> {
    const id = canonicalKey(key);
    const path = join(this.cfg.dir, `${id}.json`);
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const entry = (await f.json()) as CacheEntry;
      const age = this.now() - new Date(entry.fetchedAt).getTime();
      if (!Number.isFinite(age) || age < 0 || age > this.cfg.ttlMs) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async getOrFetch(
    key: CacheKey,
    fetcher: () => Promise<Station[]>,
  ): Promise<CacheEntry> {
    const cached = await this.get(key);
    if (cached) return cached;

    const id = canonicalKey(key);
    const existing = this.inflight.get(id);
    if (existing) return existing;

    const work = (async () => {
      try {
        const stations = await fetcher();
        const entry: CacheEntry = {
          fetchedAt: new Date(this.now()).toISOString(),
          stations,
        };
        await this.writeAtomic(id, entry).catch(() => {});
        this.prune().catch(() => {});
        return entry;
      } finally {
        this.inflight.delete(id);
      }
    })();

    this.inflight.set(id, work);
    return work;
  }

  private async writeAtomic(id: string, entry: CacheEntry): Promise<void> {
    const finalPath = join(this.cfg.dir, `${id}.json`);
    const tmpPath = join(this.cfg.dir, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
    await Bun.write(tmpPath, JSON.stringify(entry));
    await rename(tmpPath, finalPath);
  }

  private async prune(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.cfg.dir);
    } catch {
      return;
    }
    const files = entries.filter((n) => n.endsWith(".json") && !n.startsWith("."));
    if (files.length <= this.cfg.maxEntries) return;

    const stats = await Promise.all(
      files.map(async (name) => {
        const p = join(this.cfg.dir, name);
        try {
          const s = await stat(p);
          return { path: p, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    const sorted = stats
      .filter((s): s is { path: string; mtime: number } => s !== null)
      .sort((a, b) => a.mtime - b.mtime);

    const toDelete = sorted.slice(0, sorted.length - this.cfg.maxEntries);
    await Promise.all(toDelete.map((s) => unlink(s.path).catch(() => {})));
  }
}
