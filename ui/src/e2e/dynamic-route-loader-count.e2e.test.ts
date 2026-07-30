// Control UI E2E tests prove dynamic startup routes do not reload their Gateway data.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

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

describeControlUiE2e("Control UI dynamic route startup loaders", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not available at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("loads the Plugins Discover deep link once and preserves it through reconnect", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1440 } });
    const page = await context.newPage();
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

    try {
      const response = await page.goto(`${server.baseUrl}${pathname.slice(1)}`);
      expect(response?.status()).toBe(200);
      await waitForControlUiRoute(page, { pathname, routeId: "plugins" });
      expect(await activeRouteFetchCount(page)).toBe(1);

      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1001, "route loader reconnect proof");
      await expect.poll(() => gateway.getSocketCount(), { timeout: 10_000 }).toBe(socketCount + 1);
      await waitForControlUiRoute(page, { pathname, routeId: "plugins" });
      expect(await activeRouteFetchCount(page)).toBe(1);
    } finally {
      await context.close();
    }
  });
});
