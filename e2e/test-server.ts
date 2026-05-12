import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp, parseEnv } from "../src/app.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, "public");
const CACHE_DIR = mkdtempSync(join(tmpdir(), "gas-e2e-cache-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "gas-e2e-data-"));

interface MockStation {
  id: string;
  name: string;
  brand: string;
  street: string;
  houseNumber: string;
  postCode: number;
  place: string;
  lat: number;
  lng: number;
  dist: number | null;
  isOpen: boolean;
  e5: number | false;
  e10: number | false;
  diesel: number | false;
}

const DEFAULT_STATIONS: MockStation[] = [
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

// Scenarios for the Best Value feature E2E tests.
// Switch via GET /test/scenario?name=<name>; server returns the matching set
// to all subsequent /api/stations calls until switched again.
function stationsFor(scenario: string): MockStation[] {
  switch (scenario) {
    case "closed-best":
      // Closed station has the lowest absolute price — must NOT win Best Value.
      return [
        { ...DEFAULT_STATIONS[0]!, dist: 0.5, isOpen: true, e10: 1.799 },
        { ...DEFAULT_STATIONS[1]!, dist: 1.2, isOpen: true, e10: 1.819 },
        { ...DEFAULT_STATIONS[2]!, dist: 0.6, isOpen: false, e10: 1.599 },
      ];
    case "missing-price":
      // First station has no E10 price — should render `—` and be excluded from highlight.
      return [
        { ...DEFAULT_STATIONS[0]!, e10: false },
        { ...DEFAULT_STATIONS[1]! },
      ];
    case "zero-dist":
      // Station at exactly the user's coordinates — dist=0 must NOT be treated as missing.
      return [
        { ...DEFAULT_STATIONS[0]!, dist: 0, e10: 1.799 },
        { ...DEFAULT_STATIONS[1]!, dist: 5, e10: 1.699 },
      ];
    case "empty-list":
      return [];
    case "invalid-dist":
      return [
        { ...DEFAULT_STATIONS[0]!, dist: null },
        { ...DEFAULT_STATIONS[1]! },
      ];
    default:
      return DEFAULT_STATIONS;
  }
}

let currentScenario = "default";

const PHOTON_FEATURES_BERLIN = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Berlin Hauptbahnhof", city: "Berlin", country: "Deutschland" },
      geometry: { type: "Point", coordinates: [13.3696614, 52.5249451] },
    },
    {
      type: "Feature",
      properties: { name: "Mitte", city: "Berlin", country: "Deutschland" },
      geometry: { type: "Point", coordinates: [13.405, 52.52] },
    },
  ],
};

const PHOTON_EMPTY = { type: "FeatureCollection", features: [] };

const mockFetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
  if (url.includes("photon.test")) {
    const q = new URL(url).searchParams.get("q") ?? "";
    if (q.toLowerCase() === "breakme") {
      return new Response("boom", { status: 500 });
    }
    if (q.toLowerCase() === "nowhereville") {
      return new Response(JSON.stringify(PHOTON_EMPTY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(PHOTON_FEATURES_BERLIN), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Tankerkönig stations — scenario-driven for the Best Value tests.
  return new Response(JSON.stringify({ ok: true, stations: stationsFor(currentScenario) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

const env = parseEnv(
  {
    TANKERKOENIG_API_KEY: "e2e-test-key",
    PHOTON_USER_AGENT: "gas-price-monitor (e2e)",
    PHOTON_BASE_URL: "https://photon.test",
  },
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
  for (const s of DEFAULT_STATIONS) {
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
  async fetch(req) {
    const url = new URL(req.url);
    // Test-only scenario control endpoint.
    if (url.pathname === "/test/scenario") {
      const name = url.searchParams.get("name") ?? "default";
      currentScenario = name;
      // Bust the station cache so the next /api/stations call hits the fresh scenario data.
      const fs = await import("node:fs/promises");
      await fs.rm(join(CACHE_DIR, "geocode"), { recursive: true, force: true }).catch(() => {});
      const files = await fs.readdir(CACHE_DIR).catch(() => [] as string[]);
      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => fs.unlink(join(CACHE_DIR, f)).catch(() => {})),
      );
      return new Response(JSON.stringify({ scenario: name }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return app.fetch(req);
  },
});

console.log("e2e test server listening on http://localhost:3457");
