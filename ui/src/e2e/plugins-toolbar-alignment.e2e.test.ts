import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins toolbar alignment",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("keeps the Installed toolbar controls on one shared control height", async () => {
    await suite.withPage({ viewport: { height: 768, width: 1366 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["config.get", "plugins.list"],
        methodResponses: {
          "config.get": {
            config: {},
            sourceConfig: {},
            hash: "plugins-toolbar-config",
            issues: [],
            raw: "{}",
            valid: true,
          },
          "plugins.list": {
            plugins: [],
            diagnostics: [],
            mutationAllowed: true,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/plugins`);
      await waitForControlUiRoute(page, { pathname: "/settings/plugins", routeId: "plugins" });
      const search = await page.locator("#plugins-global-search").boundingBox();
      const filters = await page.locator(".plugins-toolbar > .settings-segmented").boundingBox();
      const refresh = await page.locator(".plugins-toolbar > .plugins-refresh").boundingBox();

      if (!search || !filters || !refresh) {
        throw new Error("Installed plugin toolbar controls did not render");
      }
      for (const control of [filters, refresh]) {
        expect(control.height).toBeCloseTo(search.height, 0);
        expect(control.y).toBeCloseTo(search.y, 0);
        expect(control.y + control.height).toBeCloseTo(search.y + search.height, 0);
      }
      expect(search.height).toBeCloseTo(32, 0);
    });
  });
});
