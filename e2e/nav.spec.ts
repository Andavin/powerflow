import { test, expect } from "@playwright/test";

test("navigates between sections", async ({ page }, testInfo) => {
  await page.goto("/");
  const navName = testInfo.project.name === "mobile" ? "Primary" : "Sidebar";
  const nav = page.getByRole("navigation", { name: navName });

  await nav.getByRole("link", { name: "Circuits" }).click();
  await expect(page).toHaveURL(/\/circuits$/);
  await expect(page.getByRole("heading", { name: "Circuits" })).toBeVisible();

  await nav.getByRole("link", { name: "Stats" }).click();
  await expect(page).toHaveURL(/\/stats$/);
});

test("desktop sidebar exposes the History workbench", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only nav");
  await page.goto("/");
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
});
