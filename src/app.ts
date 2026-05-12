import { resolve, sep, join } from "node:path";
import {
  listStations,
  TankerkoenigError,
  type ListStationsDeps,
  type RequestedFuel,
  type Station,
} from "./tankerkoenig.ts";
import { StationCache, type CacheConfig } from "./cache.ts";
import { History } from "./history.ts";
import { Alerts, type AlertConfig, type AlertThresholds, type AlertDeps } from "./alerts.ts";
import { Geocoder, GeocoderError } from "./geocoder.ts";
import { OsrmClient, OsrmError, type Coord, type StationCoord } from "./osrm.ts";

export interface AppEnv {
  apiKey: string;
  defaultLat: number;
  defaultLng: number;
  defaultRadius: number;
  publicDir: string;
  cacheDir: string;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  dataDir: string;
  historyMaxFileBytes: number;
  alertThresholds: AlertThresholds;
  alertWebhookUrl?: string;
  alertDesktopNotify: boolean;
  photonUserAgent: string;
  photonBaseUrl: string;
  geocodeCacheTtlMs: number;
  geocodeCacheMaxEntries: number;
  osrmUserAgent: string;
  osrmBaseUrl: string;
  osrmCacheTtlMs: number;
  osrmCacheMaxEntries: number;
  stadiaApiKey: string;
}

export interface AppDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cache?: StationCache;
  history?: History;
  alerts?: Alerts;
  alertDeps?: AlertDeps;
  geocoder?: Geocoder;
  osrm?: OsrmClient;
}

const ALLOWED_TYPES = new Set<RequestedFuel>(["e5", "e10", "diesel", "all"]);

export class ValidationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseEnv(
  source: NodeJS.ProcessEnv,
  publicDir: string,
  cacheDir: string,
  dataDir: string,
): AppEnv {
  const numFromEnv = (name: string, fallback: number, min: number, max: number): number => {
    const raw = source[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`Invalid ${name}: ${raw} (expected number in [${min}, ${max}])`);
    }
    return n;
  };

  const optionalPriceEnv = (name: string): number | undefined => {
    const raw = source[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      throw new Error(`Invalid ${name}: ${raw} (expected positive number)`);
    }
    return n;
  };

  const photonUserAgent = (source.PHOTON_USER_AGENT ?? "").trim();
  if (!photonUserAgent) {
    throw new Error(
      "PHOTON_USER_AGENT is required (set it in .env). Identify the app and a contact, e.g. 'gas-price-monitor (you@example.com)'.",
    );
  }

  const osrmUserAgent = (source.OSRM_USER_AGENT ?? "").trim();
  if (!osrmUserAgent) {
    throw new Error(
      "OSRM_USER_AGENT is required (set it in .env). Identify the app and a contact, e.g. 'gas-price-monitor (you@example.com)'.",
    );
  }

  return {
    apiKey: source.TANKERKOENIG_API_KEY ?? "",
    defaultLat: numFromEnv("DEFAULT_LAT", 52.52, -90, 90),
    defaultLng: numFromEnv("DEFAULT_LNG", 13.405, -180, 180),
    defaultRadius: numFromEnv("DEFAULT_RADIUS", 5, 1, 25),
    publicDir,
    cacheDir,
    cacheTtlMs: numFromEnv("CACHE_TTL_MS", 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    cacheMaxEntries: numFromEnv("CACHE_MAX_ENTRIES", 200, 10, 10000),
    dataDir,
    historyMaxFileBytes: numFromEnv("HISTORY_MAX_FILE_BYTES", 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    alertThresholds: {
      e5: optionalPriceEnv("ALERT_E5_BELOW"),
      e10: optionalPriceEnv("ALERT_E10_BELOW"),
      diesel: optionalPriceEnv("ALERT_DIESEL_BELOW"),
    },
    alertWebhookUrl: source.ALERT_WEBHOOK_URL || undefined,
    alertDesktopNotify: source.ALERT_DESKTOP_NOTIFY === "true",
    photonUserAgent,
    photonBaseUrl: (source.PHOTON_BASE_URL || "https://photon.komoot.io").replace(/\/+$/, ""),
    geocodeCacheTtlMs: numFromEnv("GEOCODE_CACHE_TTL_MS", 24 * 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000),
    geocodeCacheMaxEntries: numFromEnv("GEOCODE_CACHE_MAX_ENTRIES", 200, 10, 10000),
    osrmUserAgent,
    osrmBaseUrl: (source.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/+$/, ""),
    osrmCacheTtlMs: numFromEnv("OSRM_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000),
    osrmCacheMaxEntries: numFromEnv("OSRM_CACHE_MAX_ENTRIES", 500, 10, 10000),
    stadiaApiKey: (source.STADIA_API_KEY ?? "").trim(),
  };
}

function parseNum(v: string | null, fallback: number, min: number, max: number, label: string): number {
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`invalid ${label}`);
  }
  return n;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

async function serveStatic(publicDir: string, pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(publicDir, "." + rel);
  const safeRoot = resolve(publicDir) + sep;
  if (!target.startsWith(safeRoot) && target !== resolve(publicDir)) {
    return notFound();
  }
  const f = Bun.file(target);
  if (!(await f.exists())) return notFound();
  const ext = target.slice(target.lastIndexOf("."));
  const type = MIME[ext] ?? "application/octet-stream";
  return new Response(f, { headers: { "Content-Type": type } });
}

export function createApp(env: AppEnv, deps: AppDeps = {}) {
  const cache =
    deps.cache ??
    new StationCache({
      dir: env.cacheDir,
      ttlMs: env.cacheTtlMs,
      maxEntries: env.cacheMaxEntries,
      now: deps.now,
    } satisfies CacheConfig);

  const history =
    deps.history ??
    new History({
      dir: env.dataDir,
      maxFileBytes: env.historyMaxFileBytes,
      now: deps.now,
    });

  const alerts =
    deps.alerts ??
    new Alerts(
      {
        thresholds: env.alertThresholds,
        webhookUrl: env.alertWebhookUrl,
        desktopNotify: env.alertDesktopNotify,
        stateFile: join(env.dataDir, "alerts-state.json"),
        now: deps.now,
      } satisfies AlertConfig,
      deps.alertDeps ?? (deps.fetch ? { fetch: deps.fetch } : {}),
    );

  const tankerDeps: ListStationsDeps = deps.fetch ? { fetch: deps.fetch } : {};

  const geocoder =
    deps.geocoder ??
    new Geocoder(
      {
        baseUrl: env.photonBaseUrl,
        userAgent: env.photonUserAgent,
        dir: join(env.cacheDir, "geocode"),
        ttlMs: env.geocodeCacheTtlMs,
        maxEntries: env.geocodeCacheMaxEntries,
        lang: "de",
        bbox: "5.866,47.270,15.042,55.058",
        limit: 5,
      },
      { fetch: deps.fetch, now: deps.now },
    );

  const osrm =
    deps.osrm ??
    new OsrmClient(
      {
        baseUrl: env.osrmBaseUrl,
        userAgent: env.osrmUserAgent,
        dir: join(env.cacheDir, "osrm"),
        ttlMs: env.osrmCacheTtlMs,
        maxEntries: env.osrmCacheMaxEntries,
      },
      { fetch: deps.fetch, now: deps.now },
    );

  void cache.init();
  void history.init();
  void alerts.init();
  void geocoder.init();
  void osrm.init();

  async function fetchAndRecord(
    lat: number,
    lng: number,
    radius: number,
    type: RequestedFuel,
  ): Promise<Station[]> {
    const stations = await listStations({ lat, lng, radius, type }, env.apiKey, tankerDeps);
    void history.append(stations).catch(() => {});
    void alerts.check(stations).catch(() => {});
    return stations;
  }

  async function getStations(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const lat = parseNum(url.searchParams.get("lat"), env.defaultLat, -90, 90, "lat");
      const lng = parseNum(url.searchParams.get("lng"), env.defaultLng, -180, 180, "lng");
      const radius = parseNum(url.searchParams.get("radius"), env.defaultRadius, 1, 25, "radius");
      const typeParam = (url.searchParams.get("type") ?? "all") as RequestedFuel;
      if (!ALLOWED_TYPES.has(typeParam)) {
        return json({ error: "invalid fuel type" }, 400);
      }

      const entry = await cache.getOrFetch(
        {
          lat,
          lng,
          radius,
          type: typeParam,
          sort: "dist",
          apiKey: env.apiKey,
        },
        () => fetchAndRecord(lat, lng, radius, typeParam),
      );

      return json({ stations: entry.stations as Station[], fetchedAt: entry.fetchedAt });
    } catch (err) {
      if (err instanceof TankerkoenigError) {
        return json({ error: err.message }, err.status);
      }
      if (err instanceof ValidationError) {
        return json({ error: err.message }, err.status);
      }
      return json({ error: "internal error" }, 500);
    }
  }

  async function getHistory(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const idsParam = url.searchParams.get("stationIds") ?? "";
      const stationIds = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (stationIds.length === 0) {
        return json({ error: "stationIds required" }, 400);
      }
      if (stationIds.length > 50) {
        return json({ error: "too many stationIds (max 50)" }, 400);
      }
      const days = parseNum(url.searchParams.get("days"), 7, 1, 90, "days");
      const sinceMs = days * 24 * 60 * 60 * 1000;
      const byStation = await history.readForStations(stationIds, sinceMs);
      const out: Record<string, unknown> = {};
      for (const [id, buckets] of byStation) out[id] = buckets;
      return json({ stations: out });
    } catch (err) {
      if (err instanceof ValidationError) {
        return json({ error: err.message }, err.status);
      }
      return json({ error: "internal error" }, 500);
    }
  }

  async function getGeocode(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const raw = url.searchParams.get("q") ?? "";
      const canon = raw.trim().replace(/\s+/g, " ");
      if (canon.length < 2 || canon.length > 200) {
        return json({ error: "invalid query" }, 400);
      }
      const results = await geocoder.geocode(canon);
      return json({ results });
    } catch (err) {
      if (err instanceof GeocoderError) {
        return json({ error: "geocoder unavailable" }, err.status);
      }
      return json({ error: "internal error" }, 500);
    }
  }

  function getConfig(): Response {
    return json({
      defaultLat: env.defaultLat,
      defaultLng: env.defaultLng,
      defaultRadius: env.defaultRadius,
      hasApiKey: env.apiKey.length > 0,
      alertsEnabled: alerts.enabled(),
      hasStadiaKey: env.stadiaApiKey.length > 0,
      stadiaApiKey: env.stadiaApiKey,
      osrmEnabled: true,
    });
  }

  function parseCoord(lat: unknown, lng: unknown): Coord | null {
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }
    return { lat, lng };
  }

  async function postDistances(req: Request): Promise<Response> {
    try {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const obj = body as { userLat?: unknown; userLng?: unknown; stations?: unknown };
      const user = parseCoord(obj.userLat, obj.userLng);
      if (!user) {
        return json({ error: "userLat and userLng must be valid coordinates" }, 400);
      }
      if (!Array.isArray(obj.stations)) {
        return json({ error: "stations must be an array" }, 400);
      }
      if (obj.stations.length === 0) {
        return json({ distances: {} });
      }
      if (obj.stations.length > 50) {
        return json({ error: "too many stations (max 50)" }, 400);
      }
      const stations: StationCoord[] = [];
      for (const s of obj.stations) {
        const rec = s as { id?: unknown; lat?: unknown; lng?: unknown };
        if (typeof rec.id !== "string" || !rec.id) {
          return json({ error: "each station needs a string id" }, 400);
        }
        const coord = parseCoord(rec.lat, rec.lng);
        if (!coord) {
          return json({ error: `station ${rec.id} has invalid coordinates` }, 400);
        }
        stations.push({ id: rec.id, lat: coord.lat, lng: coord.lng });
      }
      const distances = await osrm.tableDistances(user, stations);
      return json({ distances });
    } catch (err) {
      if (err instanceof OsrmError) {
        return json({ error: "routing unavailable" }, err.status);
      }
      return json({ error: "internal error" }, 500);
    }
  }

  async function getRoute(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const fromLatRaw = url.searchParams.get("fromLat");
      const fromLngRaw = url.searchParams.get("fromLng");
      const toLatRaw = url.searchParams.get("toLat");
      const toLngRaw = url.searchParams.get("toLng");
      if (!fromLatRaw || !fromLngRaw || !toLatRaw || !toLngRaw) {
        return json({ error: "fromLat/fromLng/toLat/toLng are required" }, 400);
      }
      const from = parseCoord(Number(fromLatRaw), Number(fromLngRaw));
      const to = parseCoord(Number(toLatRaw), Number(toLngRaw));
      if (!from || !to) {
        return json({ error: "fromLat/fromLng/toLat/toLng must be valid coordinates" }, 400);
      }
      // Default #26: same-point rejection (5-decimal rounded match).
      if (
        Math.round(from.lat * 1e5) === Math.round(to.lat * 1e5) &&
        Math.round(from.lng * 1e5) === Math.round(to.lng * 1e5)
      ) {
        return json({ error: "from and to are the same point" }, 400);
      }
      const result = await osrm.route(from, to);
      return json({
        geometry: result.geometry,
        meters: result.meters,
        seconds: result.seconds,
      });
    } catch (err) {
      if (err instanceof OsrmError) {
        return json({ error: "routing unavailable" }, err.status);
      }
      return json({ error: "internal error" }, 500);
    }
  }

  const routes = {
    "/api/config": { GET: () => getConfig() },
    "/api/stations": { GET: (req: Request) => getStations(req) },
    "/api/history": { GET: (req: Request) => getHistory(req) },
    "/api/geocode": { GET: (req: Request) => getGeocode(req) },
    "/api/distances": { POST: (req: Request) => postDistances(req) },
    "/api/route": { GET: (req: Request) => getRoute(req) },
  } as const;

  async function fetchFallback(req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const url = new URL(req.url);
    return serveStatic(env.publicDir, url.pathname);
  }

  return { fetch: fetchFallback, routes, history, alerts, geocoder, osrm };
}
