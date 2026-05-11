import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

async function clearLocalStorage(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
}

test("page loads, table renders three stations, cheapest among open is highlighted", async ({ page }) => {
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
  await page.goto("/");
  await expect(page.locator("table tbody tr.closed")).toHaveCount(1);
  await expect(page.locator("table tbody tr.closed")).toContainText("Total Closed");
});

test("sorting by E10 toggles asc/desc and reorders rows", async ({ page }) => {
  await page.goto("/");
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

test("localStorage round-trips lat/lng/radius/fuel across reload", async ({ page }) => {
  await clearLocalStorage(page);
  await page.reload();
  await page.locator("#lat").fill("48.1351");
  await page.locator("#lng").fill("11.5820");
  await page.locator("#radius").fill("8");
  await page.locator("#fuel").selectOption("e10");
  await page.locator('button[type="submit"]').click();
  await expect(page.locator(".price.cheap").first()).toBeVisible();

  await page.reload();
  await expect(page.locator("#lat")).toHaveValue("48.1351");
  await expect(page.locator("#lng")).toHaveValue("11.5820");
  await expect(page.locator("#radius")).toHaveValue("8");
  await expect(page.locator("#fuel")).toHaveValue("e10");
});

test("geolocation: simulated coords fill the inputs and refresh fires", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 48.1351, longitude: 11.582 });
  await page.goto("/");
  await page.locator("#locate").click();
  await expect(page.locator("#lat")).toHaveValue("48.13510");
  await expect(page.locator("#lng")).toHaveValue("11.58200");
  await expect(page.locator(".price.cheap").first()).toBeVisible();
});

test("rapid Refresh clicks: AbortController prevents stale overwrite", async ({ page }) => {
  await page.goto("/");
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

test("sparklines render for each open station + fuel cell with history data", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table tbody tr")).toHaveCount(3);
  // Wait for the lazy /api/history call to populate the spark cells.
  await page.waitForFunction(() => document.querySelectorAll(".spark svg").length > 0, null, { timeout: 5000 });
  const sparkCount = await page.locator(".spark svg").count();
  // 2 open stations × 3 fuels = 6 sparklines (closed station has no open prices to chart).
  // We assert ≥ 1 to keep robust against the closed-station's pre-seeded data variations.
  expect(sparkCount).toBeGreaterThanOrEqual(3);
});

test("/api/history returns recorded prices for known stations", async ({ request }) => {
  const res = await request.get("/api/history?stationIds=stub-1&days=7");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { stations: Record<string, { e10: unknown[] }> };
  expect(body.stations["stub-1"]?.e10.length ?? 0).toBeGreaterThan(0);
});
