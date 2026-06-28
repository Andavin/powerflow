import { test, expect } from "@playwright/test";

test.describe("Stats screen", () => {
  test("defaults to home / today and renders a chart", async ({ page }) => {
    await page.goto("/stats");
    await expect(page.getByRole("tab", { name: "Today" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Consumed")).toBeVisible();
    await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
  });

  test("switches source to solar then battery", async ({ page }) => {
    await page.goto("/stats");
    await page.getByRole("tab", { name: "Solar" }).click();
    await expect(page.getByText("Generated")).toBeVisible();

    await page.getByRole("tab", { name: "Battery" }).click();
    await expect(page.getByText("Discharged", { exact: true })).toBeVisible();
    await expect(page.getByText("Charged", { exact: true })).toBeVisible();
  });

  test("switches range to month", async ({ page }) => {
    await page.goto("/stats");
    await page.getByRole("tab", { name: "Month" }).click();
    await expect(page.getByRole("tab", { name: "Month" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
  });
});
