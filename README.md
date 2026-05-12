# Gas Price Monitor

Local web dashboard for German fuel prices (E5, E10, Diesel) powered by the
[Tankerkönig](https://creativecommons.tankerkoenig.de/) open data API.

Bun + TypeScript. No external runtime dependencies — just a static HTML page
served by Bun, with a tiny proxy endpoint so the API key stays on the server.

## Setup

1. **Get a free API key** at <https://creativecommons.tankerkoenig.de/#about>.
   Register with an email; you'll get a UUID-format key.

2. **Install deps** (Bun only — no npm packages required for runtime, but
   `bun install` will pull dev types):

   ```sh
   bun install
   ```

3. **Configure**:

   ```sh
   cp .env.example .env
   # Edit .env and set:
   #   TANKERKOENIG_API_KEY=...    (your Tankerkönig key)
   #   PHOTON_USER_AGENT=...       (REQUIRED — identifier for the geocoder)
   ```

   `PHOTON_USER_AGENT` should identify your app and include a contact so
   komoot (who runs the Photon geocoder we use) can reach you if anything
   ever misbehaves. Server refuses to boot without it.

4. **Run**:

   ```sh
   bun run dev      # with hot reload
   # or
   bun run start    # plain
   ```

5. Open <http://localhost:3000>.

## Usage

- Type a location into the search box ("Berlin Mitte", "Stuttgart
  Hauptbahnhof", "Hauptstraße 42 Berlin") and pick a result. Arrow keys
  navigate the dropdown; Enter picks; Escape dismisses.
- Or hit **📍 Locate me** to use the browser's geolocation.
- Picks the cheapest open station for each fuel grade (highlighted in green).
- **Best Value column:** factors driving cost into the price. Shows net €/fill
  for your selected fuel — cheaper-but-far loses to slightly-pricier-but-near
  once you include the fuel burned getting there. Defaults assume a 40 L
  fill at 7 L/100km — adjust the **Fill (L)** and **Consumption (L/100km)**
  inputs to match your car. When Fuel is set to "All", Best Value tracks E10
  (shown as `Best Value (E10)*`).
- Auto-refreshes every 5 minutes (the Tankerkönig fair-use limit).
- Search query + picked label + coordinates + radius + fuel are all saved
  to `localStorage` so reload restores your last view.
- Each price cell shows a 7-day sparkline once history has accumulated. Green
  trend = falling, red trend = rising, gray = flat. Data persists in
  `data/history.jsonl`.
- Optional price-drop alerts: set `ALERT_E5_BELOW`, `ALERT_E10_BELOW`, or
  `ALERT_DIESEL_BELOW` in `.env`. Alerts fire once per crossing-below (debounced
  via a state file). Configure `ALERT_DESKTOP_NOTIFY=true` for `notify-send`
  pop-ups, or `ALERT_WEBHOOK_URL` for an HTTP POST.

## Endpoints

- `GET /` — dashboard
- `GET /api/config` — server defaults + flags (`hasApiKey`, `alertsEnabled`)
- `GET /api/stations?lat=&lng=&radius=&type=` — proxies Tankerkönig's
  `list.php` with server-side 5min disk caching. `type` is `e5`, `e10`,
  `diesel`, or `all`.
- `GET /api/geocode?q=...` — resolves a freeform query (place name,
  street, PLZ) to up to 5 `{label, lat, lng}` results via Photon (komoot).
  Server-side 24h disk cache, German-biased bbox. `q` must be 2-200 chars
  after canonicalization.
- `GET /api/history?stationIds=A,B,C&days=7` — historical prices for each
  requested station, grouped by fuel. Up to 50 stationIds per call.

## Notes

- Tankerkönig terms ask you to cache responses for at least 5 minutes in
  production. The server has a built-in 5-minute disk cache (in `.cache/`) and
  also auto-refreshes the dashboard on that cadence, so any client reads stay
  inside the fair-use envelope.
- Radius must be between 1 and 25 km — out-of-range values return HTTP 400.
- This is a personal/local tool — there's no auth on the server. Don't expose
  it to the open internet without putting something in front of it.

## Configuration

| Env var | Default | Notes |
|---------|---------|-------|
| `TANKERKOENIG_API_KEY` | — | Required. |
| `PHOTON_USER_AGENT` | — | **Required.** Identifier sent to the Photon geocoder. Server refuses to boot if unset. |
| `PHOTON_BASE_URL` | `https://photon.komoot.io` | Override mostly for testing or self-hosted Photon. |
| `GEOCODE_CACHE_TTL_MS` | `86400000` (24h) | |
| `GEOCODE_CACHE_MAX_ENTRIES` | `200` | LRU pruned on write. |
| `PORT` | `3000` | 1–65535. |
| `DEFAULT_LAT` | `52.5200` | Berlin Mitte. |
| `DEFAULT_LNG` | `13.4050` | |
| `DEFAULT_RADIUS` | `5` | 1–25 km. |
| `CACHE_DIR` | `.cache` (in repo) | Disk cache location (stations + geocoder). |
| `CACHE_TTL_MS` | `300000` (5 min) | Station cache. |
| `CACHE_MAX_ENTRIES` | `200` | LRU pruned on write. |
| `DATA_DIR` | `data` (in repo) | Where `history.jsonl` and `alerts-state.json` live. |
| `HISTORY_MAX_FILE_BYTES` | `52428800` (50 MB) | Rotates `history.jsonl` → `history.N.jsonl` when exceeded. |
| `ALERT_E5_BELOW` | — | Threshold (€/L). Fires alert when cheapest open E5 crosses below. |
| `ALERT_E10_BELOW` | — | Same, for E10. |
| `ALERT_DIESEL_BELOW` | — | Same, for Diesel. |
| `ALERT_DESKTOP_NOTIFY` | `false` | `true` to send `notify-send` desktop popups (Linux). |
| `ALERT_WEBHOOK_URL` | — | If set, POSTs `{fuel, threshold, price, stationId, ts}` JSON on each alert. |

Invalid env values cause the server to exit at startup with a clear message.

## Container / Kubernetes

Every push to `main` builds an `linux/amd64` image and publishes it to
`ghcr.io/nachtschatt3n/gas-price-monitor` via `.github/workflows/build.yml`.
Tags: `latest` (main HEAD), `sha-<short>` (per commit), `v<tag>` (on git tags).

For the `cberg-home-nextgen` homelab, the rollout is owned by the
`cluster-ops-agent` in that gitops repo (Flux reconciliation, no manual
kubectl). See [`CLAUDE.md`](CLAUDE.md) for the full handoff. The manifests
in [`k8s/`](k8s/README.md) are reference templates for anyone running this
elsewhere:

```sh
kubectl create secret generic gas-price-monitor --from-literal=api-key=YOUR_KEY
kubectl apply -f k8s/deployment.yaml -f k8s/service.yaml
kubectl port-forward svc/gas-price-monitor 3000:80
```

State is ephemeral (`emptyDir` for `/data` and `/cache`) — pod restarts wipe
history. Swap to a `persistentVolumeClaim` in `deployment.yaml` if you want it
to survive.

## License

Code: do what you want.
Data: Tankerkönig data is CC BY 4.0 — see <https://creativecommons.tankerkoenig.de/>.
