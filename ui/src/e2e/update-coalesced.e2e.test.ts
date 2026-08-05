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
const MANAGED_UPDATE_HANDOFF_RESPONSE = {
  ok: true,
  handoff: { status: "started" },
  result: { reason: "managed-service-handoff-started", status: "skipped" },
} as const;

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

  it("identifies a beta release in the visible Gateway update card", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/update-beta-channel");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("chat.startup");
      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          channel: "beta",
          currentVersion: "2026.7.1-2",
          latestVersion: "2026.7.2-beta.5",
        },
      });

      await page
        .getByRole("button", {
          name: /Update Gateway · v2026\.7\.2-beta\.5 \(beta\)/u,
        })
        .waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(artifactDir, "beta-update-card.png") });
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("shows package update failure status after the Update click", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/update-package-status");
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
          ok: false,
          result: { reason: "global-install-failed", status: "error" },
        },
      },
    });

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("chat.startup");
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
          "Update error: global-install-failed. The global package install did not verify on disk. Retry or reinstall from the CLI.",
          { exact: true },
        )
        .waitFor();

      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(await page.getByRole("button", { name: /Update Gateway/ }).isEnabled()).toBe(true);
      expect(pageErrors).toEqual([]);
      await page.screenshot({ path: path.join(artifactDir, "package-update-failure.png") });
    } finally {
      await context.close();
    }
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
      await gateway.waitForRequest("chat.startup");
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

  it.each([
    {
      artifactName: "response-first",
      expectedStatusRequests: 2,
      expectedText: "Expected v2.0.0, running v1.0.0",
      name: "after the response arrives before disconnect",
      responseFirst: true,
    },
    {
      artifactName: "disconnect-first",
      expectedStatusRequests: 0,
      expectedText: "The update request may have been accepted",
      name: "when disconnect arrives before the response",
      responseFirst: false,
    },
  ])(
    "settles the managed update $name",
    async ({ artifactName, expectedStatusRequests, expectedText, responseFirst }) => {
      const artifactDir = path.resolve(
        `.artifacts/control-ui-e2e/update-managed-handoff-${artifactName}`,
      );
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
        deferredMethods: ["update.run"],
        methodResponses: {
          "update.run": MANAGED_UPDATE_HANDOFF_RESPONSE,
          "update.status": {
            sequence: [
              {
                sentinel: {
                  kind: "update",
                  status: "skipped",
                  stats: { reason: "managed-service-handoff-started" },
                },
              },
              {
                sentinel: {
                  kind: "update",
                  status: "ok",
                  stats: { after: { version: "1.0.0" } },
                },
              },
            ],
          },
        },
      });

      try {
        expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          },
        });

        await page.getByRole("button", { name: /Update Gateway/ }).click();
        await gateway.waitForRequest("update.run");
        if (responseFirst) {
          await gateway.resolveDeferred("update.run", MANAGED_UPDATE_HANDOFF_RESPONSE);
          await expect
            .poll(() => page.getByRole("button", { name: /Update Gateway/ }).isEnabled())
            .toBe(true);
        }
        await gateway.closeLatest(1012, "managed update handoff");

        await page.getByText(expectedText, { exact: false }).waitFor({ timeout: 15_000 });
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(await gateway.getRequests("update.status")).toHaveLength(expectedStatusRequests);
        expect(pageErrors).toEqual([]);
        await page.screenshot({
          path: path.join(artifactDir, `managed-handoff-${artifactName}.png`),
        });
      } finally {
        await context.close();
      }
    },
  );

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
      await gateway.waitForRequest("chat.startup");
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
