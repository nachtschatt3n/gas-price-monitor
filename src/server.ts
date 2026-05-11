import { join } from "node:path";
import { createApp, parseEnv } from "./app.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, "public");
const CACHE_DIR = process.env.CACHE_DIR ?? join(ROOT, ".cache");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

let env: ReturnType<typeof parseEnv>;
try {
  env = parseEnv(process.env, PUBLIC_DIR, CACHE_DIR, DATA_DIR);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = createApp(env);

Bun.serve({
  port: PORT,
  routes: app.routes,
  fetch: app.fetch,
});

console.log(`gas-price-monitor listening on http://localhost:${PORT}`);
if (!env.apiKey) {
  console.warn("WARNING: TANKERKOENIG_API_KEY not set — /api/stations will return 500");
  console.warn("Get a free key at https://creativecommons.tankerkoenig.de/");
}
if (app.alerts.enabled()) {
  console.log(`alerts: thresholds configured (E5/E10/Diesel) — webhook=${env.alertWebhookUrl ? "on" : "off"}, desktop=${env.alertDesktopNotify}`);
}
