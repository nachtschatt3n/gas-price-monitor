import { mkdir, rename, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

interface CacheEntry {
  fetchedAt: number;
  results: GeocodeResult[];
}

export interface GeocoderConfig {
  baseUrl: string;
  userAgent: string;
  dir: string;
  ttlMs: number;
  maxEntries: number;
  bbox?: string;
  lang?: string;
  limit?: number;
}

export interface GeocoderDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class GeocoderError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "GeocoderError";
  }
}

export function canonicalize(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export function cacheKey(q: string): string {
  return createHash("sha256").update(canonicalize(q)).digest("hex").slice(0, 24);
}

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: {
    name?: unknown;
    city?: unknown;
    state?: unknown;
    country?: unknown;
    street?: unknown;
    housenumber?: unknown;
    postcode?: unknown;
  };
}

interface PhotonResponse {
  type?: string;
  features?: PhotonFeature[];
}

const LABEL_MAX = 60;

export function parseFeature(feature: PhotonFeature): GeocodeResult | null {
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  // GeoJSON: [lng, lat] — easy to invert; do not swap.
  const lng = coords[0];
  const lat = coords[1];
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const p = feature.properties ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(p.name);
  const city = str(p.city);
  const state = str(p.state);
  const country = str(p.country);
  const street = str(p.street);
  const housenumber = str(p.housenumber);

  let label = "";
  if (name) {
    label = name;
    if (city && city !== name) label += `, ${city}`;
    else if (state && state !== name) label += `, ${state}`;
  } else if (street) {
    label = housenumber ? `${street} ${housenumber}` : street;
    if (city) label += `, ${city}`;
  } else if (city) {
    label = city;
    if (state && state !== city) label += `, ${state}`;
  } else if (country) {
    label = country;
  } else {
    return null;
  }

  if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX - 1) + "…";
  return { label, lat, lng };
}

export class Geocoder {
  private now: () => number;
  private fetchImpl: typeof globalThis.fetch;
  private inflight = new Map<string, Promise<GeocodeResult[]>>();
  private ready: Promise<void>;

  constructor(private cfg: GeocoderConfig, deps: GeocoderDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.ready = mkdir(cfg.dir, { recursive: true }).then(
      () => {},
      () => {},
    );
  }

  async init(): Promise<void> {
    await this.ready;
  }

  async geocode(q: string): Promise<GeocodeResult[]> {
    await this.ready;
    const canon = canonicalize(q);
    if (!canon) return [];

    const id = cacheKey(q);
    const cached = await this.readCache(id);
    if (cached) return cached;

    const existing = this.inflight.get(id);
    if (existing) return existing;

    const work = (async () => {
      try {
        const results = await this.fetchUpstream(canon);
        await this.writeAtomic(id, { fetchedAt: this.now(), results }).catch(() => {});
        this.prune().catch(() => {});
        return results;
      } finally {
        this.inflight.delete(id);
      }
    })();

    this.inflight.set(id, work);
    return work;
  }

  private async readCache(id: string): Promise<GeocodeResult[] | null> {
    const path = join(this.cfg.dir, `${id}.json`);
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const entry = (await f.json()) as CacheEntry;
      const age = this.now() - entry.fetchedAt;
      if (!Number.isFinite(age) || age < 0 || age > this.cfg.ttlMs) return null;
      if (!Array.isArray(entry.results)) return null;
      return entry.results;
    } catch {
      return null;
    }
  }

  private async fetchUpstream(canon: string): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q: canon,
      limit: String(this.cfg.limit ?? 5),
    });
    if (this.cfg.lang) params.set("lang", this.cfg.lang);
    if (this.cfg.bbox) params.set("bbox", this.cfg.bbox);

    const url = `${this.cfg.baseUrl}/api/?${params}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": this.cfg.userAgent, Accept: "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      throw new GeocoderError(`upstream unreachable: ${msg}`, 502);
    }

    if (!res.ok) {
      throw new GeocoderError(`upstream HTTP ${res.status}`, 502);
    }

    let body: PhotonResponse;
    try {
      body = (await res.json()) as PhotonResponse;
    } catch {
      throw new GeocoderError("upstream returned malformed JSON", 502);
    }

    const features = Array.isArray(body.features) ? body.features : [];
    const out: GeocodeResult[] = [];
    for (const f of features) {
      const parsed = parseFeature(f);
      if (parsed) out.push(parsed);
      if (out.length >= (this.cfg.limit ?? 5)) break;
    }
    return out;
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
