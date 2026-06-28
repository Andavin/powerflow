import { test, expect } from "@playwright/test";

test.describe("Flow screen", () => {
  test("renders the live energy-flow diagram", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("img", { name: /energy flow/i })).toBeVisible();
  });

  test("lists the top current consumers", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/using the most power/i)).toBeVisible();
    // Deterministic mock: the EV charger is the biggest draw.
    await expect(page.getByText("EV Charger")).toBeVisible();
  });
});
