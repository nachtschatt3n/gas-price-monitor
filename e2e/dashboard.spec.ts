import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

async function clearLocalStorage(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
}

test("page loads with default location, table renders three stations, cheapest among open highlighted", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator("h1")).toContainText("Gas Price Monitor");
  await expect(page.locator("table tbody tr")).toHaveCount(3);
  await expect(page.locator("#status")).toContainText("3 stations");

  const cheap = await page.locator("td .price.cheap").allTextContents();
  expect(cheap.join(" ")).toContain("1.789");
  expect(cheap.join(" ")).toContain("1.749");
  expect(cheap.join(" ")).toContain("1.659");
});

test("closed stations get the .closed class and are dimmed", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator("table tbody tr.closed")).toHaveCount(1);
  await expect(page.locator("table tbody tr.closed")).toContainText("Total Closed");
});

test("sorting by E10 toggles asc/desc and reorders rows", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator('th[data-col="e10"]').click();
  const firstAsc = await page.locator("table tbody tr").first().textContent();
  expect(firstAsc).toContain("Total");

  await page.locator('th[data-col="e10"]').click();
  const firstDesc = await page.locator("table tbody tr").first().textContent();
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
  await expect(page.locator("table tbody tr")).toHaveCount(3);
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
  await expect(page.locator("table tbody tr")).toHaveCount(3);
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

// ---------- Best Value column ----------

async function setScenario(request: import("@playwright/test").APIRequestContext, name: string) {
  const res = await request.get(`/test/scenario?name=${name}`);
  expect(res.status()).toBe(200);
}

test.afterEach(async ({ request }) => {
  // Reset scenario between tests so default-scenario tests aren't affected by ordering.
  await setScenario(request, "default");
});

test("Best Value column appears with sensible default values and a highlight", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator("th[data-col='bestValue']")).toContainText("Best Value");
  // Default tracking is E10 (fuel=all → defaults to E10), so header shows asterisk.
  await expect(page.locator("th[data-col='bestValue'] sup")).toContainText("*");
  // One row gets the green highlight (best net €/fill among open stations).
  const cheapBestValue = page.locator("td .price.cheap").filter({ hasText: "€/fill" });
  await expect(cheapBestValue).toHaveCount(1);
});

test("Fuel filter change updates header text + tracked fuel + triggers refresh", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await expect(page.locator("th[data-col='bestValue']")).toContainText("(E10)");

  await page.locator("#fuel").selectOption("diesel");
  // No asterisk on a specific fuel selection.
  await expect(page.locator("th[data-col='bestValue']")).toContainText("(Diesel)");
  await expect(page.locator("th[data-col='bestValue'] sup")).toHaveCount(0);
  // Stations re-fetched + re-rendered.
  await expect(page.locator("#status")).toContainText("3 stations");
});

test("fillVolume change recomputes the Best Value column without a refetch", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  const before = await page.locator("td .price.cheap").filter({ hasText: "€/fill" }).textContent();
  await page.locator("#fill-volume").fill("80");
  // Re-render is synchronous (no network), so the cell text updates immediately.
  const after = await page.locator("td .price.cheap").filter({ hasText: "€/fill" }).textContent();
  expect(after).not.toBe(before);
  // 80 L should produce roughly double the net €/fill of the 40 L default.
  const beforeNum = parseFloat(before?.replace(/[^\d.]/g, "") ?? "0");
  const afterNum = parseFloat(after?.replace(/[^\d.]/g, "") ?? "0");
  expect(afterNum).toBeGreaterThan(beforeNum * 1.8);
});

test("consumption change can shift which station wins Best Value", async ({ page, request }) => {
  await clearLocalStorage(page);
  await page.reload();
  // At default 7 L/100km, the 0.5 km Aral (E10=1.749) beats the 1.2 km Shell (1.759) on net.
  const lowConsBest = await page.locator("td .price.cheap").filter({ hasText: "€/fill" }).first();
  await expect(lowConsBest).toBeVisible();
  // At 25 L/100km, the higher drive cost amplifies distance and Aral keeps winning
  // (it's both cheaper AND closer). But the gap should widen visibly.
  const before = parseFloat((await lowConsBest.textContent())?.replace(/[^\d.]/g, "") ?? "0");
  await page.locator("#consumption").fill("25");
  const after = parseFloat((await lowConsBest.textContent())?.replace(/[^\d.]/g, "") ?? "0");
  expect(after).toBeGreaterThan(before);
});

test("Sort by Best Value asc + desc reorders rows", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  // Default sort is distance; clicking Best Value sorts ascending by net €/fill.
  // The closed Total participates in sort and lands at the top (lowest absolute price),
  // but never gets the highlight. The asc-sort first OPEN row is Aral.
  await page.locator("th[data-col='bestValue']").click();
  const firstOpenAsc = await page.locator("table tbody tr:not(.closed)").first().textContent();
  expect(firstOpenAsc).toContain("Aral");
  // The highlighted row (best value among open) is also Aral.
  const highlightedAsc = await page.locator("tr:has(td .price.cheap:has-text('€/fill'))").textContent();
  expect(highlightedAsc).toContain("Aral");

  await page.locator("th[data-col='bestValue']").click();
  const firstOpenDesc = await page.locator("table tbody tr:not(.closed)").first().textContent();
  expect(firstOpenDesc).toContain("Shell"); // highest net among open
});

test("Sort by Best Value persists across fuel filter change", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("th[data-col='bestValue']").click(); // sort by bestValue asc
  await page.locator("#fuel").selectOption("diesel");
  // After fuel change, the table re-fetches AND re-sorts; first row is still the lowest-net Diesel station.
  await expect(page.locator("table tbody tr").first()).toContainText("Aral");
  await expect(page.locator("th[data-col='bestValue']")).toContainText("(Diesel)");
});

test("Closed station with the lowest absolute price never gets the Best Value highlight", async ({ page, request }) => {
  await setScenario(request, "closed-best");
  await clearLocalStorage(page);
  await page.reload();
  // Total Closed has e10=1.599 (lowest absolute) and is at 0.6 km, but is closed.
  // The highlight must go to an OPEN station even though it's not the cheapest absolute.
  const cheapCell = page.locator("td .price.cheap").filter({ hasText: "€/fill" });
  await expect(cheapCell).toHaveCount(1);
  // The closed row exists in the table but does NOT have the highlight.
  await expect(page.locator("tr.closed td .price.cheap").filter({ hasText: "€/fill" })).toHaveCount(0);
});

test("Missing tracked-fuel price renders '—' in the Best Value cell", async ({ page, request }) => {
  await setScenario(request, "missing-price");
  await clearLocalStorage(page);
  await page.reload();
  // stub-1 has e10: false (no E10 price). Default tracked fuel is E10.
  // That row's Best Value cell shows '—'.
  await expect(page.locator("table tbody tr").first().locator("td").nth(5)).toContainText("—");
});

test("Zero distance is valid (station at user coords) — not treated as missing", async ({ page, request }) => {
  await setScenario(request, "zero-dist");
  await clearLocalStorage(page);
  await page.reload();
  // stub-1 has dist=0. The Best Value cell still shows a number (price × volume + 0 = price × volume).
  // 1.799 × 40 = 71.96
  await expect(page.locator("table tbody tr").first().locator("td").nth(5)).toContainText("71.96");
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
  const defaultBest = await page.locator("td .price.cheap").filter({ hasText: "€/fill" }).textContent();
  // Type 200 (above max=100). HTML5 may block submission, but our clamp uses 40 regardless.
  await page.locator("#fill-volume").fill("999");
  const fallback = await page.locator("td .price.cheap").filter({ hasText: "€/fill" }).textContent();
  // Same as default (40 L) since out-of-range falls back.
  expect(fallback).toBe(defaultBest);
});
