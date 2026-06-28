import { test, expect } from "@playwright/test";

// Guards against the animation silently freezing (e.g. the SMIL regression):
// the streaks must exist and actually translate along their conduits.
test("energy-flow streaks animate along the conduits", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("svg .pf-streak", { timeout: 10_000 });

  // getScreenCTM reflects the CSS offset-path transform (.e/.f translation).
  const read = () =>
    page.$$eval("svg .pf-streak", (els) =>
      els.map((el) => {
        const m = (el as SVGGraphicsElement).getScreenCTM();
        return m ? { e: Math.round(m.e * 10) / 10, f: Math.round(m.f * 10) / 10 } : null;
      }),
    );

  const a = await read();
  await page.waitForTimeout(450);
  const b = await read();

  expect(a.length).toBeGreaterThan(0);
  const moved = a.some(
    (v, i) => v && b[i] && (Math.abs(v.e - b[i]!.e) > 1 || Math.abs(v.f - b[i]!.f) > 1),
  );
  expect(moved).toBe(true);
});
