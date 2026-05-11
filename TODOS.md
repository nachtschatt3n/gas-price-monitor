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

---

### Design follow-ups from /design-review (2026-05-11)

7 design findings were fixed atomically on `main` (commits `7c7edc9`,
`fd569f3`, `a74c02f`, `9c7151c`, `dcfccf3`, `dc40ca5`, `67bf701`): focus
rings, keyboard-operable sort headers, 44px touch targets, mobile card
layout, `aria-live` status, label/badge size bumps, footer link
affordance. Design score B → A-. The following remained deferred because
each involves a real tradeoff:

**1. Replace `ui-sans-serif / system-ui` primary font with a real typeface
(Inter, Geist, IBM Plex Sans).** This is the one remaining AI-slop signal.
The current stack is the "I gave up on typography" default. Trade-off: adds
an external font dep, costs the 50ms load budget. Decide whether design
expression is worth the perf cost on a homelab tool.

**2. Form font-size 14px → 16px on mobile to prevent iOS auto-zoom on
focus.** iOS Safari zooms into form fields when the rendered font-size is
below 16px. A mobile-only `@media` override on `input, select, button {
font-size: 16px }` would fix it without changing desktop density.

**3. Split `--accent` into `--brand` (CTA buttons) vs `--cheapest` (price
highlighting).** Currently the green is overloaded: primary button, cheapest
price, OPEN badge all share the same `#4ade80`. The semantic collision is
visible when every station ties on demo data (every cell saturates green).
Trade-off: rename touches 6+ CSS rules and HTML class refs, moderate
regression risk.

**4. Add a `@media (prefers-reduced-motion: reduce)` block.** Preventive
only — the app has effectively no motion to suppress today.

**5. Active sort column more prominent.** The arrow on the active column is
50% opacity (subdued). Could be 100% + accent color + bold. Subjective taste.

**6. Extract spacing tokens (`--space-1..6`) as CSS variables.** Padding
values are hardcoded throughout; works fine, just not systematic. Cosmetic.

**7. Tied-prices edge case.** When ALL stations have the same minimum
price (only happens with the Tankerkönig demo key — fixed `1.009 €/L`), the
cheapest-highlight saturates every cell green. Real data doesn't trigger it.
Decide whether to keep "all unique-minima → green" or switch to "if all
tied, highlight none". Low priority.

**Depends on / blocked by:** Nothing. Pick any subset of these on the next
pass. Full audit report: `~/.gstack/projects/gas-price-monitor/designs/design-audit-20260511/design-audit-localhost.md`.
