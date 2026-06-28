import { test, expect, type Page } from "@playwright/test";

// Guards against the animation silently freezing (the SMIL / offset-path
// regressions): the streaks must exist and actually translate along their
// conduits — including under reduced motion, since the flow animation is a
// core feature driven by requestAnimationFrame, not CSS.
async function assertStreaksMove(page: Page) {
  await page.goto("/");
  await page.waitForSelector("svg .pf-streak", { timeout: 10_000 });

  // getScreenCTM reflects the JS-applied transform (.e/.f translation).
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
}

test("energy-flow streaks animate along the conduits", async ({ page }) => {
  await assertStreaksMove(page);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("streaks still animate (rAF, not CSS)", async ({ page }) => {
    await assertStreaksMove(page);
  });
});
