import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

async function clearLocalStorage(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
}

test("page loads with default location, station cards render three stations, cheapest among open highlighted", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator("h1")).toContainText("Gas Price Monitor");
  await expect(page.locator(".station-card")).toHaveCount(3);
  await expect(page.locator("#status")).toContainText("3 stations");

  const cheap = await page.locator(".station-card .price.cheap").allTextContents();
  expect(cheap.join(" ")).toContain("1.789");
  expect(cheap.join(" ")).toContain("1.749");
  expect(cheap.join(" ")).toContain("1.659");
});

test("closed stations get the .closed class and are dimmed", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator(".station-card.closed")).toHaveCount(1);
  await expect(page.locator(".station-card.closed")).toContainText("Total Closed");
});

test("sorting by E10 toggles asc/desc and reorders cards", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator('.sort-btn[data-col="e10"]').click();
  const firstAsc = await page.locator(".station-card").first().textContent();
  expect(firstAsc).toContain("Total");

  await page.locator('.sort-btn[data-col="e10"]').click();
  const firstDesc = await page.locator(".station-card").first().textContent();
  expect(firstDesc).toContain("Shell");
});

test("server rejects radius > 25 with a 400 and clear error message", async ({ request }) => {
  const res = await request.get("/api/stations?radius=99");
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/radius/);
});

test("typing into #q fires debounced geocode and renders the picker", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("Berlin");
  await expect(page.locator(".q-result").first()).toBeVisible({ timeout: 3000 });
  const results = await page.locator(".q-result").allTextContents();
  expect(results.length).toBeGreaterThan(0);
  expect(results.join(" | ")).toContain("Berlin");
});

test("ArrowDown + Enter picks the highlighted location and refreshes stations", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("Berlin");
  await expect(page.locator(".q-result.highlight").first()).toBeVisible();
  await page.locator("#q").press("ArrowDown");
  await page.locator("#q").press("Enter");
  // Picker closes, q value swaps to the picked label, stations refresh.
  await expect(page.locator(".q-results")).toBeHidden();
  await expect(page.locator("#q")).toHaveValue("Mitte, Berlin");
  await expect(page.locator("#status")).toContainText("3 stations");
});

test("no-result query shows the empty state in the picker", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("Nowhereville");
  await expect(page.locator(".q-result.empty")).toContainText("No locations found", { timeout: 3000 });
});

test("upstream geocoder error shows the error state in the picker", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("BREAKME");
  await expect(page.locator(".q-result.error")).toContainText("unavailable", { timeout: 3000 });
});

test("Escape closes the picker without picking", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("Berlin");
  await expect(page.locator(".q-result").first()).toBeVisible();
  await page.locator("#q").press("Escape");
  await expect(page.locator(".q-results")).toBeHidden();
});

test("localStorage round-trips q/label/coords/radius/fuel across reload", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#q").fill("Berlin");
  await expect(page.locator(".q-result").first()).toBeVisible();
  await page.locator("#q").press("Enter"); // pick first highlighted
  await expect(page.locator("#q")).toHaveValue("Berlin Hauptbahnhof, Berlin");
  await page.locator("#radius").fill("8");
  await page.locator("#fuel").selectOption("e10");
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("#status")).toContainText("3 stations");

  await page.reload();
  await expect(page.locator("#q")).toHaveValue("Berlin Hauptbahnhof, Berlin");
  await expect(page.locator("#radius")).toHaveValue("8");
  await expect(page.locator("#fuel")).toHaveValue("e10");
});

test("geolocation: button populates state.location with 'Current location' and refreshes", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 48.1351, longitude: 11.582 });
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#locate").click();
  await expect(page.locator("#q")).toHaveValue("Current location");
  await expect(page.locator("#status")).toContainText("3 stations");
});

test("rapid Refresh clicks: AbortController prevents stale overwrite", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator('button[type="submit"]').click();
  await page.locator('button[type="submit"]').click();
  await page.locator('button[type="submit"]').click();
  await expect(page.locator(".station-card")).toHaveCount(3);
  await expect(page.locator("#status")).toContainText("3 stations");
});

test("/api/config exposes hasApiKey=true in this test setup", async ({ request }) => {
  const res = await request.get("/api/config");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ hasApiKey: true });
});

test("/api/geocode happy path returns parsed results", async ({ request }) => {
  const res = await request.get("/api/geocode?q=Berlin");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { results: { label: string; lat: number; lng: number }[] };
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results[0]?.label).toMatch(/Berlin/);
});

test("/api/geocode rejects empty query with 400", async ({ request }) => {
  const res = await request.get("/api/geocode?q=");
  expect(res.status()).toBe(400);
});

test("sparklines render for open stations once history data loads", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator(".station-card")).toHaveCount(3);
  await page.waitForFunction(() => document.querySelectorAll(".spark svg").length > 0, null, { timeout: 5000 });
  const sparkCount = await page.locator(".spark svg").count();
  expect(sparkCount).toBeGreaterThanOrEqual(3);
});

test("/api/history returns recorded prices for known stations", async ({ request }) => {
  const res = await request.get("/api/history?stationIds=stub-1&days=7");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { stations: Record<string, { e10: unknown[] }> };
  expect(body.stations["stub-1"]?.e10.length ?? 0).toBeGreaterThan(0);
});

// ---------- Best Value ----------

async function setScenario(request: import("@playwright/test").APIRequestContext, name: string) {
  const res = await request.get(`/test/scenario?name=${name}`);
  expect(res.status()).toBe(200);
}

test.afterEach(async ({ request }) => {
  // Reset scenario between tests so default-scenario tests aren't affected by ordering.
  await setScenario(request, "default");
});

test("Best Value label appears with sensible default values and a highlight", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator(".bv-label")).toContainText("Best Value");
  // Default tracking is E10 (fuel=all → defaults to E10), so the label shows an asterisk.
  await expect(page.locator(".bv-label sup")).toContainText("*");
  // One card gets the green highlight (best net €/fill among open stations).
  const cheapBestValue = page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" });
  await expect(cheapBestValue).toHaveCount(1);
});

test("Fuel filter change updates label text + tracked fuel + triggers refresh", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator(".bv-label")).toContainText("(E10)");

  await page.locator("#fuel").selectOption("diesel");
  // No asterisk on a specific fuel selection.
  await expect(page.locator(".bv-label")).toContainText("(Diesel)");
  await expect(page.locator(".bv-label sup")).toHaveCount(0);
  // Stations re-fetched + re-rendered.
  await expect(page.locator("#status")).toContainText("3 stations");
});

test("fillVolume change recomputes the Best Value figure without a refetch", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  const before = await page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" }).textContent();
  await page.locator("#fill-volume").fill("80");
  // Re-render is synchronous (no network), so the value updates immediately.
  const after = await page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" }).textContent();
  expect(after).not.toBe(before);
  // 80 L should produce roughly double the net €/fill of the 40 L default.
  const beforeNum = parseFloat(before?.replace(/[^\d.]/g, "") ?? "0");
  const afterNum = parseFloat(after?.replace(/[^\d.]/g, "") ?? "0");
  expect(afterNum).toBeGreaterThan(beforeNum * 1.8);
});

test("consumption change can shift which station wins Best Value", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  // At default 7 L/100km, the 0.5 km Aral (E10=1.749) beats the 1.2 km Shell (1.759) on net.
  const lowConsBest = await page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" }).first();
  await expect(lowConsBest).toBeVisible();
  // At 25 L/100km, the higher drive cost amplifies distance and Aral keeps winning
  // (it's both cheaper AND closer). But the gap should widen visibly.
  const before = parseFloat((await lowConsBest.textContent())?.replace(/[^\d.]/g, "") ?? "0");
  await page.locator("#consumption").fill("25");
  const after = parseFloat((await lowConsBest.textContent())?.replace(/[^\d.]/g, "") ?? "0");
  expect(after).toBeGreaterThan(before);
});

test("Sort by Best Value asc + desc reorders cards", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  // Default sort is distance; clicking Best Value sorts ascending by net €/fill.
  // The closed Total participates in sort and lands at the top (lowest absolute price),
  // but never gets the highlight. The asc-sort first OPEN card is Aral.
  await page.locator(".sort-btn[data-col='bestValue']").click();
  const firstOpenAsc = await page.locator(".station-card:not(.closed)").first().textContent();
  expect(firstOpenAsc).toContain("Aral");
  // The highlighted card (best value among open) is also Aral.
  const highlightedAsc = await page.locator(".station-card:has(.price.cheap:has-text('€/fill'))").textContent();
  expect(highlightedAsc).toContain("Aral");

  await page.locator(".sort-btn[data-col='bestValue']").click();
  const firstOpenDesc = await page.locator(".station-card:not(.closed)").first().textContent();
  expect(firstOpenDesc).toContain("Shell"); // highest net among open
});

test("Sort by Best Value persists across fuel filter change", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator(".sort-btn[data-col='bestValue']").click(); // sort by bestValue asc
  await page.locator("#fuel").selectOption("diesel");
  // After fuel change, the list re-fetches AND re-sorts. Closed stations still
  // participate in the visible sort, but the first open card is the best-value
  // Diesel station.
  await expect(page.locator(".station-card:not(.closed)").first()).toContainText("Aral");
  await expect(page.locator(".bv-label")).toContainText("(Diesel)");
});

test("Closed station with the lowest absolute price never gets the Best Value highlight", async ({ page, request }) => {
  await setScenario(request, "closed-best");
  await clearLocalStorage(page);
  await page.reload();
  // Total Closed has e10=1.599 (lowest absolute) and is at 0.6 km, but is closed.
  // The highlight must go to an OPEN station even though it's not the cheapest absolute.
  const cheapBv = page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" });
  await expect(cheapBv).toHaveCount(1);
  // The closed card exists but does NOT have the best-value highlight.
  await expect(page.locator(".station-card.closed .price.cheap").filter({ hasText: "€/fill" })).toHaveCount(0);
});

test("Missing tracked-fuel price renders '—' in the Best Value figure", async ({ page, request }) => {
  await setScenario(request, "missing-price");
  await clearLocalStorage(page);
  await page.reload();
  // stub-1 has e10: false (no E10 price). Default tracked fuel is E10.
  // That card's Best Value figure shows '—'.
  await expect(page.locator(".station-card").first().locator(".sc-bestvalue")).toContainText("—");
});

test("Zero distance is valid (station at user coords) — not treated as missing", async ({ page, request }) => {
  await setScenario(request, "zero-dist");
  // Force OSRM down so Best Value uses straight-line s.dist (=0 for this station).
  await request.get("/test/osrm-scenario?name=osrm-down");
  await clearLocalStorage(page);
  await page.reload();
  // stub-1 has dist=0. Straight-line fallback: price × volume + 0 = price × volume.
  // 1.799 × 40 = 71.96
  await expect(page.locator(".station-card").first().locator(".sc-bestvalue")).toContainText("71.96");
  // Reset for other tests.
  await request.get("/test/osrm-scenario?name=default");
});

test("localStorage round-trips fillVolume + consumption across reload", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#fill-volume").fill("55");
  await page.locator("#consumption").fill("9.5");
  // Trigger a refresh to flush prefs to localStorage.
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("#status")).toContainText("3 stations");

  await page.reload();
  await expect(page.locator("#fill-volume")).toHaveValue("55");
  await expect(page.locator("#consumption")).toHaveValue("9.5");
});

test("Out-of-range fillVolume falls back to default for computation", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  const defaultBest = await page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" }).textContent();
  // Type 999 (above max=100). HTML5 may block submission, but our clamp uses 40 regardless.
  await page.locator("#fill-volume").fill("999");
  const fallback = await page.locator(".station-card .price.cheap").filter({ hasText: "€/fill" }).textContent();
  // Same as default (40 L) since out-of-range falls back.
  expect(fallback).toBe(defaultBest);
});

// ============================================================================
// Map + OSRM + Geolocation specs (Lane D9)
// ============================================================================

test.describe("Map: rendering + tile load", () => {
  test("Leaflet initializes and renders at least one tile", async ({ page }) => {
    await clearLocalStorage(page);
    await page.reload();
    await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 5000 });
    // Leaflet renders 6+ tiles for a typical viewport; just assert >=1.
    await expect(page.locator(".leaflet-tile").first()).toBeVisible({ timeout: 5000 });
  });

  test("user pin and station markers are rendered as divIcons", async ({ page }) => {
    await clearLocalStorage(page);
    await page.reload();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    // Wait for markers to attach.
    await expect(page.locator(".gpm-pin--user")).toBeVisible();
    // Three stations in the default scenario (one closed).
    await expect(page.locator(".gpm-pin--winner, .gpm-pin--open, .gpm-pin--closed")).toHaveCount(3);
    // Exactly one winner.
    await expect(page.locator(".gpm-pin--winner")).toHaveCount(1);
  });
});

test.describe("Best Value `~` lifecycle (Default #13)", () => {
  test("OSRM success: `~` disappears from the bv-label once /api/distances returns", async ({ page }) => {
    await clearLocalStorage(page);
    await page.reload();
    // Eventually OSRM returns and `~` is gone from the best-value label.
    await expect(page.locator(".bv-label .approx-mark")).toHaveCount(0, { timeout: 5000 });
  });

  test("OSRM error: `~` stays in the bv-label", async ({ page, request }) => {
    await clearLocalStorage(page);
    // Force OSRM to 5xx for this test.
    await request.get("/test/osrm-scenario?name=osrm-down");
    await page.reload();
    // The bv-label `~` should still be visible because state.osrmStatus = "error".
    await expect(page.locator(".bv-label .approx-mark").first()).toBeVisible({ timeout: 5000 });
    // Reset for other tests.
    await request.get("/test/osrm-scenario?name=default");
  });

  test("Per-card `~` shown for the no-route station only", async ({ page, request }) => {
    await clearLocalStorage(page);
    await request.get("/test/osrm-scenario?name=no-route");
    await page.reload();
    // Wait for OSRM to land (bv-label `~` should be gone since the matrix arrived).
    await expect(page.locator(".bv-label .approx-mark")).toHaveCount(0, { timeout: 5000 });
    // Exactly one per-card `~` (the first station in the matrix had null).
    await expect(page.locator(".station-card .approx-mark")).toHaveCount(1);
    await request.get("/test/osrm-scenario?name=default");
  });
});

test.describe("Geolocation button (Default #27 state machine)", () => {
  test("granted: coords update, label becomes 'Current location', refresh fires", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 52.5, longitude: 13.4 });
    await clearLocalStorage(page);
    await page.reload();
    await expect(page.locator(".station-card")).toHaveCount(3, { timeout: 5000 });
    await page.locator("#locate").click();
    // After geolocation success, the search box label switches.
    await expect(page.locator("#q")).toHaveValue("Current location", { timeout: 5000 });
    // Status still shows stations.
    await expect(page.locator("#status")).toContainText("stations", { timeout: 5000 });
  });

  test("denied: inline message shows, label stays put", async ({ page, context }) => {
    await context.clearPermissions(); // no geolocation permission
    await clearLocalStorage(page);
    await page.reload();
    await expect(page.locator(".station-card")).toHaveCount(3, { timeout: 5000 });
    const labelBefore = await page.locator("#q").inputValue();
    await page.locator("#locate").click();
    // Either denied or unsupported — both result in an err-class message.
    await expect(page.locator("#geoloc-msg.err")).toBeVisible({ timeout: 5000 });
    // Label is unchanged (no successful coords).
    expect(await page.locator("#q").inputValue()).toBe(labelBefore);
  });
});

test.describe("Map-first layout", () => {
  test("desktop: map fills the viewport beside the stations panel, not sticky", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await clearLocalStorage(page);
    await page.reload();
    const wrap = page.locator(".map-wrap");
    await expect(wrap).toBeVisible();
    await expect(page.locator(".panel")).toBeVisible();
    const position = await wrap.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("relative");
    // Map dominates the fold (full viewport height, give or take rounding).
    const height = await wrap.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(600);
  });

  test("mobile viewport: map stacks above the panel, NOT sticky, footnote visible", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await clearLocalStorage(page);
    await page.reload();
    const wrap = page.locator(".map-wrap");
    const position = await wrap.evaluate((el) => getComputedStyle(el).position);
    expect(position).not.toBe("sticky");
    // Mobile footnote visible.
    await expect(page.locator(".map-footnote")).toBeVisible();
  });
});

test.describe("API: /api/distances", () => {
  test("happy path returns id-keyed distance map", async ({ request }) => {
    const res = await request.post("/api/distances", {
      data: {
        userLat: 52.52,
        userLng: 13.405,
        stations: [
          { id: "stub-1", lat: 52.521, lng: 13.41 },
          { id: "stub-2", lat: 52.519, lng: 13.39 },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { distances: Record<string, { meters: number; seconds: number }> };
    expect(body.distances["stub-1"]?.meters).toBeGreaterThan(0);
    expect(body.distances["stub-2"]?.meters).toBeGreaterThan(0);
  });

  test("rejects >50 stations with 400", async ({ request }) => {
    const stations = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, lat: 52.5, lng: 13.4 }));
    const res = await request.post("/api/distances", {
      data: { userLat: 52.52, userLng: 13.405, stations },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("API: /api/route", () => {
  test("happy path returns geometry + meters + seconds", async ({ request }) => {
    const res = await request.get(
      "/api/route?fromLat=52.52&fromLng=13.405&toLat=52.521&toLng=13.41",
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { meters: number; geometry: { coordinates: unknown[] } };
    expect(body.meters).toBeGreaterThan(0);
    expect(Array.isArray(body.geometry.coordinates)).toBe(true);
  });

  test("from == to returns 400", async ({ request }) => {
    const res = await request.get(
      "/api/route?fromLat=52.52&fromLng=13.405&toLat=52.52&toLng=13.405",
    );
    expect(res.status()).toBe(400);
  });
});
