import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT = "openclaw:native-update-availability-changed";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI coalesced update E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows coalesced restart feedback after the Update click", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/update-coalesced");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "update.run": {
          ok: true,
          restart: { coalesced: true },
          result: { after: { version: "2.0.0" }, status: "ok" },
        },
      },
    });

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          channel: "stable",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        },
      });

      await page.getByRole("button", { name: /Update Gateway/ }).click();
      await page
        .getByText(
          "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
          { exact: true },
        )
        .waitFor();

      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(await page.getByRole("button", { name: /Update Gateway/ }).isEnabled()).toBe(true);
      expect(pageErrors).toEqual([]);
      await page.screenshot({ path: path.join(artifactDir, "coalesced-restart-banner.png") });
    } finally {
      await context.close();
    }
  });

  it("shows and routes the update target from live Mac app ownership", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/update-ownership");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    await context.addInitScript(() => {
      const nativeWindow = window as unknown as {
        openClawUpdateMessages: unknown[];
        webkit: {
          messageHandlers: { openclawUpdate: { postMessage: (message: unknown) => void } };
        };
      };
      nativeWindow.openClawUpdateMessages = [];
      nativeWindow.webkit = {
        messageHandlers: {
          openclawUpdate: {
            postMessage: (message) => nativeWindow.openClawUpdateMessages.push(message),
          },
        },
      };
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "update.run": {
          ok: true,
          restart: null,
          result: { after: { version: "2.0.0" }, status: "ok" },
        },
      },
    });

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          channel: "stable",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        },
      });

      await page.getByRole("button", { name: /Update Mac app \+ Gateway/ }).click();
      expect(
        await page.evaluate(
          () => (window as unknown as { openClawUpdateMessages: unknown[] }).openClawUpdateMessages,
        ),
      ).toEqual([{ type: "start-update" }]);
      expect(await gateway.getRequests("update.run")).toHaveLength(0);

      await page.evaluate((eventName) => {
        Reflect.deleteProperty(window, "webkit");
        window.dispatchEvent(new CustomEvent(eventName));
      }, NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT);
      await page.getByRole("button", { name: /Update Gateway/ }).click();

      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(pageErrors).toEqual([]);
      await page.screenshot({ path: path.join(artifactDir, "gateway-update-target.png") });
    } finally {
      await context.close();
    }
  });
});
