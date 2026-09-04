import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { closeContext } from "./login-gate-e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI stale-build recovery E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("cache-busts stale-build recovery on a first dashboard navigation", async () => {
    const context = await suite.browser.newContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const documentRequests: Array<{ fresh: boolean; pathname: string }> = [];
    const appOrigin = new URL(suite.server.baseUrl).origin;
    await page.route(`${appOrigin}/**`, async (route) => {
      const request = route.request();
      if (request.resourceType() === "document") {
        const url = new URL(request.url());
        documentRequests.push({
          fresh: url.searchParams.has("openclaw_mount_recovery"),
          pathname: url.pathname,
        });
      }
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      sessionKey: "agent:example-agent:example-session",
    });
    const mismatch = {
      code: "UNAVAILABLE",
      message: "Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    };
    const target = new URL("dashboard/example-agent/example-session", suite.server.baseUrl);

    try {
      await page.goto(target.href);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);

      await expect.poll(() => documentRequests.length).toBe(2);
      await gateway.waitForRequest("connect");
      expect(documentRequests).toEqual([
        { fresh: false, pathname: target.pathname },
        { fresh: true, pathname: target.pathname },
      ]);
      await gateway.resolveDeferred("connect");

      await page.locator("openclaw-app-shell").waitFor();
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      await expect.poll(() => page.url()).toBe(target.href);
    } finally {
      await closeContext(context);
    }
  });
});
