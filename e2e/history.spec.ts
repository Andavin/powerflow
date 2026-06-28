import { test, expect } from "@playwright/test";

test.describe("History workbench", () => {
  test("renders a custom-range total and chart", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Selected period")).toBeVisible();
    await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
  });

  test("adds a previous-period comparison", async ({ page }) => {
    await page.goto("/history");
    await page.getByRole("button", { name: /compare to previous period/i }).click();
    await expect(page.getByText("Comparison period")).toBeVisible();
    await expect(page.getByText("Change")).toBeVisible();
  });

  test("applies a quick preset and switches source", async ({ page }) => {
    await page.goto("/history");
    await page.getByRole("button", { name: "30 days" }).click();
    await page.getByRole("button", { name: "Solar" }).click();
    await expect(page.getByRole("button", { name: "Solar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
