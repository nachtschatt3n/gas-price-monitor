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

## Endpoints

- `GET /` — dashboard
- `GET /api/config` — returns server defaults + whether the API key is set
- `GET /api/stations?lat=&lng=&radius=&type=` — proxies Tankerkönig's
  `list.php`. `type` is `e5`, `e10`, `diesel`, or `all`.

## Notes

- Tankerkönig terms ask you to cache responses for at least 5 minutes in
  production. The dashboard's auto-refresh respects this; if you script
  against `/api/stations` directly, please do the same.
- Radius is clamped to 1–25 km.
- This is a personal/local tool — there's no auth on the server. Don't expose
  it to the open internet without putting something in front of it.

## License

Code: do what you want.
Data: Tankerkönig data is CC BY 4.0 — see <https://creativecommons.tankerkoenig.de/>.
