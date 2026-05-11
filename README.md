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
   # then edit .env and paste your TANKERKOENIG_API_KEY
   ```

4. **Run**:

   ```sh
   bun run dev      # with hot reload
   # or
   bun run start    # plain
   ```

5. Open <http://localhost:3000>.

## Usage

- Enter latitude/longitude/radius, or hit **📍 Locate me** to use the browser's
  geolocation.
- Picks the cheapest open station for each fuel grade (highlighted in green).
- Auto-refreshes every 5 minutes (the Tankerkönig fair-use limit).
- Settings are saved to `localStorage`.
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
| `PORT` | `3000` | 1–65535. |
| `DEFAULT_LAT` | `52.5200` | Berlin Mitte. |
| `DEFAULT_LNG` | `13.4050` | |
| `DEFAULT_RADIUS` | `5` | 1–25 km. |
| `CACHE_DIR` | `.cache` (in repo) | Disk cache location. |
| `CACHE_TTL_MS` | `300000` (5 min) | |
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

Deployment manifests live in [`k8s/`](k8s/README.md). TL;DR:

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
