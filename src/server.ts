import { file } from "bun";
import { join } from "node:path";
import { listStations, TankerkoenigError, type FuelType } from "./tankerkoenig.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, "public");

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.TANKERKOENIG_API_KEY ?? "";

const DEFAULT_LAT = Number(process.env.DEFAULT_LAT ?? 52.5200);
const DEFAULT_LNG = Number(process.env.DEFAULT_LNG ?? 13.4050);
const DEFAULT_RADIUS = Number(process.env.DEFAULT_RADIUS ?? 5);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseNum(v: string | null, fallback: number, min: number, max: number): number {
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`invalid number: ${v}`);
  }
  return n;
}

const ALLOWED_TYPES = new Set(["e5", "e10", "diesel", "all"]);

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = rel.replace(/\.\./g, "");
  const target = join(PUBLIC_DIR, safe);
  const f = file(target);
  if (!(await f.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(f);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/config") {
      return json({
        defaultLat: DEFAULT_LAT,
        defaultLng: DEFAULT_LNG,
        defaultRadius: DEFAULT_RADIUS,
        hasApiKey: API_KEY.length > 0,
      });
    }

    if (url.pathname === "/api/stations") {
      try {
        const lat = parseNum(url.searchParams.get("lat"), DEFAULT_LAT, -90, 90);
        const lng = parseNum(url.searchParams.get("lng"), DEFAULT_LNG, -180, 180);
        const radius = parseNum(url.searchParams.get("radius"), DEFAULT_RADIUS, 1, 25);
        const typeParam = url.searchParams.get("type") ?? "all";
        if (!ALLOWED_TYPES.has(typeParam)) {
          return json({ error: "invalid fuel type" }, 400);
        }
        const type = typeParam as FuelType | "all";

        const stations = await listStations({ lat, lng, radius, type }, API_KEY);
        return json({ stations, fetchedAt: new Date().toISOString() });
      } catch (err) {
        if (err instanceof TankerkoenigError) {
          return json({ error: err.message }, err.status);
        }
        if (err instanceof Error) {
          return json({ error: err.message }, 400);
        }
        return json({ error: "unknown error" }, 500);
      }
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname);
    }

    return new Response("method not allowed", { status: 405 });
  },
});

console.log(`gas-price-monitor listening on http://localhost:${PORT}`);
if (!API_KEY) {
  console.warn("WARNING: TANKERKOENIG_API_KEY not set — /api/stations will return 500");
  console.warn("Get a free key at https://creativecommons.tankerkoenig.de/");
}
