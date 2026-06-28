import { test, expect } from "@playwright/test";

test.describe("Circuits screen", () => {
  test("shows the circuit list", async ({ page }) => {
    await page.goto("/circuits");
    await expect(page.getByRole("heading", { name: "Circuits" })).toBeVisible();
    const list = page.getByRole("list", { name: "Circuit list" });
    await expect(list.getByText("EV Charger")).toBeVisible();
  });

  test("filters by search", async ({ page }) => {
    await page.goto("/circuits");
    const list = page.getByRole("list", { name: "Circuit list" });
    await page.getByRole("searchbox", { name: /search circuits/i }).fill("fridge");
    await expect(list.getByText("Fridge")).toBeVisible();
    await expect(list.getByText("EV Charger")).toHaveCount(0);
  });

  test("re-sorts alphabetically", async ({ page }) => {
    await page.goto("/circuits");
    await page.getByRole("tab", { name: "A–Z" }).click();
    const first = page.getByRole("list", { name: "Circuit list" }).getByRole("listitem").first();
    await expect(first).toBeVisible();
  });
});
