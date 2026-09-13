import { test, expect } from "@playwright/test";

// The Playwright server runs with dummy VAPID keys (see playwright.config.ts),
// so the app offers notifications; nothing here ever subscribes.

test("serves the manifest, service worker, and icons", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = await manifest.json();
  expect(body.display).toBe("standalone");
  expect(body.icons.map((i: { src: string }) => i.src)).toContain("/icon-192.png");

  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toContain("notificationclick");

  const icon = await request.get("/icon-192.png");
  expect(icon.headers()["content-type"]).toBe("image/png");
});

test("advertises the public key", async ({ request }) => {
  const res = await request.get("/api/push/config");
  expect(await res.json()).toEqual({ publicKey: "e2e-public-key" });
});

test("offers notifications, and 'Maybe later' sticks across reloads", async ({ page }) => {
  // Headless browsers report notifications as already denied; present a
  // browser that hasn't been asked yet, which is the case the card is for.
  await page.addInitScript(() => {
    if ("Notification" in window) Object.defineProperty(Notification, "permission", { get: () => "default" });
  });
  await page.goto("/");
  const pushCapable = await page.evaluate(() => "PushManager" in window && window.isSecureContext);
  test.skip(!pushCapable, "this browser can't do push");

  const card = page.getByRole("status").filter({ hasText: "Get notified" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Maybe later" }).click();
  await expect(card).toBeHidden();

  await page.reload();
  await page.waitForTimeout(1500); // longer than the card's show delay
  await expect(card).toBeHidden();
});
