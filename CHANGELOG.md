# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adopts a 4-digit `MAJOR.MINOR.PATCH.MICRO` scheme
(npm `package.json` shows the first three digits).

## [0.2.0.0] - 2026-05-13

### Added
- **Interactive map** of nearby gas stations. Vendored Leaflet 1.9.4 at
  `public/lib/`; loads lazily on first search so cold load is unchanged.
  Stadia Maps dark tiles when `STADIA_API_KEY` is set, OSM raw tiles
  otherwise.
- **Real driving distance** for the Best Value calc via OSRM
  (`router.project-osrm.org` by default). Replaces the previous
  straight-line approximation; spread between nearest and furthest
  stations now reflects ~30 km of actual road instead of ~10 km of
  bird's-eye line.
- **"📍 Use my location"** button with a full state machine: idle /
  requesting / success / denied / timeout / unsupported. Shows an inline
  error message instead of a silent failure when the browser blocks
  geolocation.
- **Best Value uncertainty mark** (`~`) in the column header during the
  pending OSRM phase, removed once driving distances land. Per-cell `~`
  marks stations OSRM couldn't route to (e.g., islands, ferries).
  Screen-reader friendly via `aria-label`.
- **Sticky desktop map** at `top: 16px`, height clamped to
  `min(600px, calc(100vh - 32px))` so it works on short laptops without
  pushing controls below the fold.
- **Mobile map height** clamped to `min(400px, 55vh)` so it doesn't bury
  the table on small phones; map appears above the table on mobile,
  right of it on desktop.
- New API endpoints:
  - `POST /api/distances` — batch driving distances via OSRM `/table`,
    capped at 50 stations.
  - `GET /api/route` — single driving polyline + meters + seconds via
    OSRM `/route`.
- New env vars: `OSRM_USER_AGENT` (required), `OSRM_BASE_URL`,
  `OSRM_CACHE_TTL_MS`, `OSRM_CACHE_MAX_ENTRIES`, `STADIA_API_KEY`
  (optional).

### Changed
- Default vehicle consumption bumped from 7 → 8 L/100km. Reflects a
  typical midsize car instead of a small car; gives more weight to
  distance in the Best Value calculation.
- Best Value calculation now reads from `state.distances` (the OSRM
  result) when available, falling back to straight-line distance
  silently when OSRM is unavailable.
- `OsrmClient` mirrors the existing `Geocoder` / `StationCache`
  contract: 7-day disk cache, atomic temp-then-rename writes,
  in-flight Promise dedupe, LRU prune at `OSRM_CACHE_MAX_ENTRIES`
  entries (default 500), 5-decimal coord canonicalization.
- `/api/config` exposes `hasStadiaKey`, `stadiaApiKey`, and
  `osrmEnabled` flags so the frontend picks the right tile provider
  + footer attribution.

### Fixed
- **OSRM `destinations` parameter syntax.** The matrix endpoint
  requires semicolon-separated indices (`destinations=1;2;3`), not
  comma. Single-station happy-path tests passed (one index) while every
  multi-station `/api/distances` request returned 400 from OSRM,
  mapped to 502, silently fell back to straight-line. Visible symptom:
  the Best Value spread between 35 km and 5 km stations looked
  identical because driving distance never reached the calc.
- Footer attribution renders the configured tile + routing providers
  even before the map initializes.

### Notes
- Map a11y is intentionally deferred to v0.3 (keyboard pan, screen
  reader markers, reduced-motion). Tracked in `TODOS.md`. The table
  remains the canonical answer for SR / keyboard users.
- Public OSRM demo instance enforces `max-table-size: 50` (some
  builds) and is documented as "small-scale use only." The 7-day
  disk cache + coord canonicalization is the mitigation;
  `OSRM_BASE_URL` points at a self-hosted instance if traffic ever
  exceeds the demo's fair use.

## [0.1.0] - 2026-05-11

Initial release: Bun + TypeScript dashboard for the Tankerkönig
fuel-price API. Photon location search, Best Value column with
straight-line distance, sparklines, alerts, history.
