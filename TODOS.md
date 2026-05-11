# TODOS

## Shipped (was here, now done)

- ✅ Price history tracking (JSONL) — `src/history.ts`, persists every cache
  miss to `data/history.jsonl` with 50MB rotation.
- ✅ Price-drop notifications — `src/alerts.ts`, fires libnotify and/or webhook
  POST on threshold crossing, debounced via `data/alerts-state.json`.
- ✅ Sparkline chart per station — 7-day SVG sparkline in each price cell,
  green/red/gray trend coloring.

## Open

### History pruning (older than N days)

**What:** Add a background pass that drops history rows older than 90 days (or
configurable via `HISTORY_RETENTION_DAYS`). Cheapest implementation: on each
rotation event, run a sweep that rewrites the oldest rotated file into a kept
window and unlinks the rest.

**Why:** Without pruning, `history.N.jsonl` files accumulate forever. 50MB ≈ ~30
days at typical 10-stations-per-5-min cadence. Sparklines never read more than
7 days, so anything older than that is mostly dead weight.

**Pros:** Bounded disk usage. Faster sparkline reads (less to scan).

**Cons:** Loses the long-tail data that would power "compare against last
year" features. If you ever want year-over-year you'd need pre-aggregated
storage instead.

**Context:** Sketch — `History.prune(maxAgeMs)` reads all `history.*.jsonl`
files, drops any whose mtime is older than the cutoff, and rewrites the
oldest still-needed file to drop pre-cutoff lines. Trigger from rotation or
on a 24h Bun.setInterval.

**Depends on / blocked by:** Nothing.

---

### Multi-location bookmarks

**What:** Let the user save several locations (home, work, parents) and
switch between them via a dropdown. Currently only one set of coords is
remembered in localStorage.

**Why:** Anyone who refuels in more than one place has to keep editing
coordinates by hand.

**Pros:** Real UX upgrade with little code. Saved locations could also feed
into the cache so all of them auto-warm.

**Cons:** Scope creep on the UI — needs an "add", "rename", "delete"
flow. Probably wants a small dialog rather than always-visible inputs.

**Context:** Store as `{ bookmarks: [{name, lat, lng, radius}], activeName }`
in localStorage. Add a `<select>` next to the form that switches the active
bookmark. "Add current as new" button.

**Depends on / blocked by:** Nothing.

---

### Map view (Leaflet/MapLibre)

**What:** Optional map tab showing stations as pins, color-coded by current
price for the selected fuel. Click pin → highlight row in the table.

**Why:** "Which station is cheapest" answers a price question; "where is
the cheapest one" answers a route question. Map shows both at once.

**Pros:** Visual at-a-glance. Especially useful when radius > 10km.

**Cons:** Adds a 50KB+ JS dependency (Leaflet) + a tile provider (OSM is
free, no key). Real scope increase.

**Depends on / blocked by:** Nothing technical. Decide whether a personal
tool warrants a map dep.
