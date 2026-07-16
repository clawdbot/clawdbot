import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("embedded terminal document", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders only the terminal with a tab-attached close control while native auth connects", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
            gatewayUrl: string;
            token: string;
          };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "native-terminal-token",
      };
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "terminal-e2e",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    });

    try {
      const response = await page.goto(`${server.baseUrl}?view=terminal`);
      expect(response?.status()).toBe(200);
      const connect = await gateway.waitForRequest("connect");

      expect(connect.params).toMatchObject({ auth: { token: "native-terminal-token" } });
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);

      await gateway.resolveDeferred("connect");
      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
      });
      const colorQueries = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-e2e",
        seq: colorQueries.length,
        data: colorQueries,
      });
      await expect.poll(async () => (await gateway.getRequests("terminal.input")).length).toBe(2);
      expect((await gateway.getRequests("terminal.input")).map(({ params }) => params)).toEqual([
        {
          sessionId: "terminal-e2e",
          data: "\u001b]10;rgb:1b1b/1e1e/2626\u001b\\",
        },
        {
          sessionId: "terminal-e2e",
          data: "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
        },
      ]);
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);
      const closeControlMetrics = await page
        .locator("openclaw-terminal-panel")
        .locator(".tabstrip-tab__close")
        .evaluate((close) => {
          const header = close.closest<HTMLElement>(".tp-header");
          if (!header) {
            throw new Error("Terminal close control must stay inside the tab header");
          }
          const headerBounds = header.getBoundingClientRect();
          const closeBounds = close.getBoundingClientRect();
          return {
            centerOffset: Math.abs(
              closeBounds.top +
                closeBounds.height / 2 -
                (headerBounds.top + headerBounds.height / 2),
            ),
            height: closeBounds.height,
            width: closeBounds.width,
          };
        });
      expect(closeControlMetrics.width).toBe(24);
      expect(closeControlMetrics.height).toBe(36);
      expect(closeControlMetrics.centerOffset).toBeLessThanOrEqual(0.5);
      const closeControl = page.locator("openclaw-terminal-panel").locator(".tabstrip-tab__close");
      expect(await closeControl.getAttribute("aria-label")).toBe("Close terminal session: bash");
      await closeControl.click();
      const terminalClose = await gateway.waitForRequest("terminal.close");
      expect(terminalClose.params).toEqual({ sessionId: "terminal-e2e" });
    } finally {
      await context.close();
    }
  });
});
