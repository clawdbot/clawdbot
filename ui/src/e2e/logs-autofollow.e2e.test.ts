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

const logLines = Array.from({ length: 200 }, (_value, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "autofollow-e2e" }),
    "1": `log line ${index + 1}`,
    time: new Date(Date.UTC(2026, 6, 13, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);

describeControlUiE2e("Control UI logs auto-follow mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("returns to the newest line when auto-follow is re-enabled", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1_200 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await installMockGateway(page, {
      methodResponses: {
        "logs.tail": {
          cursor: logLines.length,
          file: "/tmp/openclaw.log",
          lines: logLines,
          reset: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}logs`);
      await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);

      const stream = page.locator(".log-stream");
      const autoFollow = page.locator("wa-switch.settings-toggle").filter({
        hasText: "Auto-follow",
      });
      await expect
        .poll(() => stream.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(0);
      await expect
        .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
        .toBe(true);
      await autoFollow.click();
      await expect
        .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
        .toBe(false);
      await stream.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);

      await autoFollow.click();
      await expect
        .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
        .toBe(true);

      await expect
        .poll(() =>
          stream.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThan(2);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
