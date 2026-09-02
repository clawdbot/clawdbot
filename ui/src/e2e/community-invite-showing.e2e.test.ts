import { expect, it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community invite showing E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const STORAGE_KEY = "openclaw:control-ui:community-invite";

suite.define(() => {
  it("shows immediately, survives Join, and stays dismissed across gateways", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator("openclaw-community-invite-card");
      await card.waitFor({ state: "visible" });

      const firstState = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      expect(JSON.parse(firstState ?? "null")).toMatchObject({
        firstShownAtMs: expect.any(Number),
      });

      const popupPromise = context.waitForEvent("page");
      await page.getByRole("link", { name: "Join us on Discord", exact: true }).click();
      const popup = await popupPromise;
      await expect
        .poll(() => popup.url())
        .toMatch(/^https:\/\/discord\.(?:gg\/clawd|com\/invite\/clawd)/u);
      await popup.close();
      await card.waitFor({ state: "visible" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(firstState);

      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      expect(
        JSON.parse(
          (await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)) ?? "null",
        ),
      ).toMatchObject({
        dismissedAtMs: expect.any(Number),
        firstShownAtMs: expect.any(Number),
      });

      await page.reload();
      await page.locator("openclaw-app-sidebar").waitFor();
      expect(await card.count()).toBe(0);

      const otherGatewayPage = await context.newPage();
      await installMockGateway(otherGatewayPage);
      const otherGatewayUrl = new URL(`${suite.server.baseUrl}chat/main`);
      otherGatewayUrl.hash = new URLSearchParams({
        gatewayUrl: "ws://127.0.0.1:29991/another-gateway",
      }).toString();
      await otherGatewayPage.goto(otherGatewayUrl.href);
      const confirmation = otherGatewayPage.locator("openclaw-gateway-url-confirmation");
      await confirmation.waitFor({ state: "visible" });
      await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
      await otherGatewayPage.locator("openclaw-app-sidebar").waitFor();
      expect(await otherGatewayPage.locator("openclaw-community-invite-card").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("does not mount the workspace invite in Settings", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      expect(await page.locator("openclaw-community-invite-card").count()).toBe(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("restarts the display window after a malformed cross-tab update", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator("openclaw-community-invite-card");
      await card.waitFor({ state: "visible" });

      await page.evaluate((key) => {
        localStorage.setItem(key, "{");
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: "{" }));
      }, STORAGE_KEY);

      await page.waitForFunction((key) => {
        try {
          const state = JSON.parse(localStorage.getItem(key) ?? "null") as {
            firstShownAtMs?: unknown;
          } | null;
          return typeof state?.firstShownAtMs === "number";
        } catch {
          return false;
        }
      }, STORAGE_KEY);
      await card.waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });
});
