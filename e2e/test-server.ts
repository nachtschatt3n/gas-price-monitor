import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp, parseEnv } from "../src/app.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, "public");
const CACHE_DIR = mkdtempSync(join(tmpdir(), "gas-e2e-cache-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "gas-e2e-data-"));

const MOCK_STATIONS = [
  {
    id: "stub-1",
    name: "Aral Hauptstraße",
    brand: "Aral",
    street: "Hauptstraße",
    houseNumber: "42",
    postCode: 10115,
    place: "Berlin",
    lat: 52.521,
    lng: 13.41,
    dist: 0.5,
    isOpen: true,
    e5: 1.789,
    e10: 1.749,
    diesel: 1.659,
  },
  {
    id: "stub-2",
    name: "Shell Friedrichstraße",
    brand: "Shell",
    street: "Friedrichstraße",
    houseNumber: "7",
    postCode: 10117,
    place: "Berlin",
    lat: 52.519,
    lng: 13.39,
    dist: 1.2,
    isOpen: true,
    e5: 1.799,
    e10: 1.759,
    diesel: 1.669,
  },
  {
    id: "stub-3",
    name: "Total Closed",
    brand: "Total",
    street: "Karl-Marx-Allee",
    houseNumber: "1",
    postCode: 10178,
    place: "Berlin",
    lat: 52.52,
    lng: 13.42,
    dist: 2.1,
    isOpen: false,
    e5: 1.749,
    e10: 1.709,
    diesel: 1.629,
  },
];

const mockFetch = (async () =>
  new Response(JSON.stringify({ ok: true, stations: MOCK_STATIONS }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

const env = parseEnv(
  { TANKERKOENIG_API_KEY: "e2e-test-key" },
  PUBLIC_DIR,
  CACHE_DIR,
  DATA_DIR,
);

const app = createApp(env, { fetch: mockFetch });

// Pre-seed history with 7 days of synthetic points so sparklines have data.
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const seedLines: string[] = [];
for (let i = 6; i >= 0; i--) {
  const ts = now - i * day;
  const variation = i * 0.005;
  for (const s of MOCK_STATIONS) {
    if (!s.isOpen) continue;
    seedLines.push(
      JSON.stringify({
        ts,
        stationId: s.id,
        name: s.name,
        brand: s.brand,
        lat: s.lat,
        lng: s.lng,
        e5: typeof s.e5 === "number" ? s.e5 - variation : false,
        e10: typeof s.e10 === "number" ? s.e10 - variation : false,
        diesel: typeof s.diesel === "number" ? s.diesel - variation : false,
        isOpen: s.isOpen,
      }),
    );
  }
}
await Bun.write(join(DATA_DIR, "history.jsonl"), seedLines.join("\n") + "\n");

Bun.serve({
  port: 3457,
  routes: app.routes,
  fetch: app.fetch,
});

console.log("e2e test server listening on http://localhost:3457");
