import { expect, it } from "vitest";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance control layout",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps accent and theme controls accessible across responsive layouts", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { height: 1000, width: 1440 } },
      async ({ page }) => {
        const config = { ui: { prefs: { accent: "#c3cfdb", theme: "claw" } } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "appearance-layout",
              config,
              configRevisionHash: "appearance-layout",
              hash: "appearance-layout",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
          },
        });
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({
            json: { ...createControlUiMockBootstrapConfig(), seamColor: "#123456" },
          }),
        );
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiSettingsTakeover(page);

        const accent = page.locator("#settings-appearance-accent");
        const customPicker = accent.locator("[data-accent-custom]");
        const customSwatch = accent.locator(".settings-accent-swatch--custom");
        await expect
          .poll(() => customPicker.getAttribute("aria-describedby"))
          .toBe("settings-accent-status");
        await expect
          .poll(() => accent.locator("#settings-accent-status").textContent())
          .toContain("Using Custom color");
        await accent.locator('[data-accent-preset="slate"]').focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => customPicker.evaluate((element) => element.matches(":focus-visible")))
          .toBe(true);
        await expect
          .poll(() =>
            customSwatch.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                boxShadow: style.boxShadow,
                outlineOffset: style.outlineOffset,
                outlineWidth: style.outlineWidth,
              };
            }),
          )
          .toMatchObject({ outlineOffset: "4px", outlineWidth: "2px" });
        expect(
          await customSwatch.evaluate((element) => getComputedStyle(element).boxShadow),
        ).not.toBe("none");

        const theme = page.locator("#settings-appearance-theme");
        const grid = theme.locator(".settings-theme-grid");
        for (const [width, expectedColumns] of [
          [560, 2],
          [320, 1],
        ] as const) {
          await page.setViewportSize({ height: 1000, width });
          const layout = await grid.evaluate((element) => {
            const cards = Array.from(element.children, (card) =>
              (card as HTMLElement).getBoundingClientRect(),
            );
            return {
              columns: new Set(cards.map((card) => Math.round(card.left))).size,
              minWidth: Math.min(...cards.map((card) => card.width)),
            };
          });
          expect(layout.columns).toBe(expectedColumns);
          expect(layout.minWidth).toBeGreaterThanOrEqual(150);
        }

        const colorMode = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: "Color mode" }) });
        await page.setViewportSize({ height: 1000, width: 768 });
        await expect
          .poll(() => colorMode.evaluate((element) => getComputedStyle(element).flexDirection))
          .toBe("column");
        await page.setViewportSize({ height: 1000, width: 769 });
        await expect
          .poll(() => colorMode.evaluate((element) => getComputedStyle(element).flexDirection))
          .toBe("row");
      },
    );
  });
});
