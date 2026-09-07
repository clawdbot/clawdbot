// Control UI E2E tests prove dynamic startup routes do not reload their Gateway data.
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dynamic route startup loaders",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

async function activeRouteFetchCount(page: import("playwright").Page): Promise<number | null> {
  return page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        router: {
          getState: () => { matches: Array<{ fetchCount: number }> };
        };
      };
    };
    return app.runtime?.router.getState().matches[0]?.fetchCount ?? null;
  });
}

suite.define(() => {
  it("loads the Plugins Discover deep link once and preserves it through reconnect", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["plugins.list"],
        methodResponses: {
          "plugins.list": {
            diagnostics: [],
            mutationAllowed: true,
            plugins: [],
          },
        },
      });
      const pathname = "/settings/plugins/discover";

      const response = await page.goto(`${suite.server.baseUrl}${pathname.slice(1)}`);
      expect(response?.status()).toBe(200);
      await waitForControlUiRoute(page, { pathname, routeId: "plugins" });
      expect(await activeRouteFetchCount(page)).toBe(1);

      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1001, "route loader reconnect proof");
      await expect.poll(() => gateway.getSocketCount(), { timeout: 10_000 }).toBe(socketCount + 1);
      await waitForControlUiRoute(page, { pathname, routeId: "plugins" });
      expect(await activeRouteFetchCount(page)).toBe(1);
    });
  });
});
