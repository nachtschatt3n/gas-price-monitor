import { mkdir, rename, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export interface Coord {
  lat: number;
  lng: number;
}

export interface StationCoord extends Coord {
  id: string;
}

export interface DistanceResult {
  meters: number;
  seconds: number;
}

export interface DistanceMap {
  [stationId: string]: DistanceResult;
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface RouteResult {
  geometry: GeoJSONLineString;
  meters: number;
  seconds: number;
}

export interface OsrmConfig {
  baseUrl: string;
  userAgent: string;
  dir: string;
  ttlMs: number;
  maxEntries: number;
}

export interface OsrmDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class OsrmError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "OsrmError";
  }
}

// 5-decimal canonicalization (~0.7m at 52°N latitude per Default #22).
export function canonCoord(c: Coord): [number, number] {
  return [Math.round(c.lat * 1e5) / 1e5, Math.round(c.lng * 1e5) / 1e5];
}

function coordKey(c: Coord): string {
  const [lat, lng] = canonCoord(c);
  return `${lat},${lng}`;
}

export function tableCacheKey(user: Coord, stations: Coord[]): string {
  const userPart = coordKey(user);
  const stationParts = stations.map(coordKey).sort();
  const input = `table|${userPart}|${stationParts.join(";")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function routeCacheKey(from: Coord, to: Coord): string {
  const input = `route|${coordKey(from)}|${coordKey(to)}|driving`;
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

interface OsrmTableResponse {
  code?: string;
  distances?: (number | null)[][];
  durations?: (number | null)[][];
}

interface OsrmRouteResponse {
  code?: string;
  routes?: Array<{
    geometry?: GeoJSONLineString;
    distance?: number;
    duration?: number;
  }>;
}

interface TableCacheEntry {
  fetchedAt: number;
  // stationCoordKey -> result | null (null means no-route from OSRM)
  results: Record<string, DistanceResult | null>;
}

interface RouteCacheEntry {
  fetchedAt: number;
  result: RouteResult;
}

export class OsrmClient {
  private now: () => number;
  private fetchImpl: typeof globalThis.fetch;
  private inflight = new Map<string, Promise<unknown>>();
  private ready: Promise<void>;

  constructor(private cfg: OsrmConfig, deps: OsrmDeps = {}) {
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

  async tableDistances(user: Coord, stations: StationCoord[]): Promise<DistanceMap> {
    await this.ready;
    if (stations.length === 0) return {};

    const id = tableCacheKey(user, stations);
    const cached = await this.readTableCache(id);
    if (cached) return this.applyTableEntry(stations, cached);

    const existing = this.inflight.get(id) as Promise<TableCacheEntry> | undefined;
    if (existing) {
      const entry = await existing;
      return this.applyTableEntry(stations, entry);
    }

    const work = (async (): Promise<TableCacheEntry> => {
      try {
        const results = await this.fetchTable(user, stations);
        const entry: TableCacheEntry = { fetchedAt: this.now(), results };
        await this.writeAtomic(id, entry).catch(() => {});
        this.prune().catch(() => {});
        return entry;
      } finally {
        this.inflight.delete(id);
      }
    })();

    this.inflight.set(id, work);
    const entry = await work;
    return this.applyTableEntry(stations, entry);
  }

  async route(from: Coord, to: Coord): Promise<RouteResult> {
    await this.ready;

    const id = routeCacheKey(from, to);
    const cached = await this.readRouteCache(id);
    if (cached) return cached;

    const existing = this.inflight.get(id) as Promise<RouteCacheEntry> | undefined;
    if (existing) return (await existing).result;

    const work = (async (): Promise<RouteCacheEntry> => {
      try {
        const result = await this.fetchRoute(from, to);
        const entry: RouteCacheEntry = { fetchedAt: this.now(), result };
        await this.writeAtomic(id, entry).catch(() => {});
        this.prune().catch(() => {});
        return entry;
      } finally {
        this.inflight.delete(id);
      }
    })();

    this.inflight.set(id, work);
    return (await work).result;
  }

  private applyTableEntry(stations: StationCoord[], entry: TableCacheEntry): DistanceMap {
    const out: DistanceMap = {};
    for (const s of stations) {
      const key = coordKey(s);
      const hit = entry.results[key];
      if (hit) out[s.id] = hit;
    }
    return out;
  }

  private async fetchTable(
    user: Coord,
    stations: StationCoord[],
  ): Promise<Record<string, DistanceResult | null>> {
    // OSRM coord syntax: lng,lat (NOT lat,lng) per Default #4. User=0, stations=1..N.
    // CRITICAL: `destinations` is SEMICOLON-separated, NOT comma. OSRM returns 400
    // "Query string malformed" for comma-joined indices. This was the bug that
    // silently broke the entire driving-distance feature in v1.
    const allCoords = [user, ...stations];
    const coordsStr = allCoords.map((c) => `${c.lng},${c.lat}`).join(";");
    const destinations = stations.map((_, i) => i + 1).join(";");
    const url = `${this.cfg.baseUrl}/table/v1/driving/${coordsStr}?sources=0&destinations=${destinations}&annotations=distance,duration`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": this.cfg.userAgent, Accept: "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      throw new OsrmError(`upstream unreachable: ${msg}`, 502);
    }

    if (!res.ok) {
      throw new OsrmError(`upstream HTTP ${res.status}`, 502);
    }

    let body: OsrmTableResponse;
    try {
      body = (await res.json()) as OsrmTableResponse;
    } catch {
      throw new OsrmError("upstream returned malformed JSON", 502);
    }

    if (body.code !== "Ok") {
      throw new OsrmError(`upstream code ${body.code ?? "missing"}`, 502);
    }

    const distRow = body.distances?.[0];
    const durRow = body.durations?.[0];
    if (!Array.isArray(distRow) || !Array.isArray(durRow)) {
      throw new OsrmError("upstream missing distance/duration matrix", 502);
    }
    if (distRow.length !== stations.length || durRow.length !== stations.length) {
      throw new OsrmError("upstream matrix length mismatch", 502);
    }

    const userKey = coordKey(user);
    const results: Record<string, DistanceResult | null> = {};
    for (let i = 0; i < stations.length; i++) {
      const station = stations[i]!;
      const stationKey = coordKey(station);
      const meters = distRow[i];
      const seconds = durRow[i];

      if (meters === null || seconds === null) {
        results[stationKey] = null;
        continue;
      }
      if (typeof meters !== "number" || typeof seconds !== "number") {
        results[stationKey] = null;
        continue;
      }
      // Default #21 (revised): treat 0 as no-route ONLY when rounded coords differ.
      // If they're equal, the user is parked at the station and 0m is ground truth.
      if (meters === 0 && stationKey !== userKey) {
        results[stationKey] = null;
        continue;
      }
      results[stationKey] = { meters, seconds };
    }
    return results;
  }

  private async fetchRoute(from: Coord, to: Coord): Promise<RouteResult> {
    const url = `${this.cfg.baseUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": this.cfg.userAgent, Accept: "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      throw new OsrmError(`upstream unreachable: ${msg}`, 502);
    }

    if (!res.ok) {
      throw new OsrmError(`upstream HTTP ${res.status}`, 502);
    }

    let body: OsrmRouteResponse;
    try {
      body = (await res.json()) as OsrmRouteResponse;
    } catch {
      throw new OsrmError("upstream returned malformed JSON", 502);
    }

    if (body.code !== "Ok") {
      throw new OsrmError(`upstream code ${body.code ?? "missing"}`, 502);
    }

    const route = body.routes?.[0];
    if (
      !route?.geometry ||
      typeof route.distance !== "number" ||
      typeof route.duration !== "number"
    ) {
      throw new OsrmError("upstream missing route data", 502);
    }
    if (route.geometry.type !== "LineString" || !Array.isArray(route.geometry.coordinates)) {
      throw new OsrmError("upstream geometry is not a LineString", 502);
    }

    return {
      geometry: route.geometry,
      meters: route.distance,
      seconds: route.duration,
    };
  }

  private async readTableCache(id: string): Promise<TableCacheEntry | null> {
    const path = join(this.cfg.dir, `${id}.json`);
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const entry = (await f.json()) as TableCacheEntry;
      const age = this.now() - entry.fetchedAt;
      if (!Number.isFinite(age) || age < 0 || age > this.cfg.ttlMs) return null;
      if (!entry.results || typeof entry.results !== "object") return null;
      return entry;
    } catch {
      return null;
    }
  }

  private async readRouteCache(id: string): Promise<RouteResult | null> {
    const path = join(this.cfg.dir, `${id}.json`);
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const entry = (await f.json()) as RouteCacheEntry;
      const age = this.now() - entry.fetchedAt;
      if (!Number.isFinite(age) || age < 0 || age > this.cfg.ttlMs) return null;
      if (!entry.result?.geometry || typeof entry.result.meters !== "number") return null;
      return entry.result;
    } catch {
      return null;
    }
  }

  private async writeAtomic(id: string, entry: unknown): Promise<void> {
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
