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
  it("shows immediately, survives Join, and stays dismissed across gateway connections on one origin", async () => {
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

      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      const cta = page.getByRole("link", { name: "Join us on Discord", exact: true });
      expect(await cta.getAttribute("href")).toBe("https://discord.gg/clawd");
      expect(await cta.getAttribute("target")).toBe("_blank");
      expect((await cta.getAttribute("rel"))?.split(/\s+/u)).toEqual(
        expect.arrayContaining(["noopener", "noreferrer"]),
      );
      await context.route("https://discord.gg/**", (route) => route.abort());
      const popupPromise = context.waitForEvent("page");
      await cta.click();
      const popup = await popupPromise;
      await popup.close();
      await card.waitFor({ state: "visible" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      expect(
        JSON.parse(
          (await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)) ?? "null",
        ),
      ).toMatchObject({
        dismissedAtMs: expect.any(Number),
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

  it("keeps the invite visible when dismissal cannot be persisted", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript((key) => {
      const setItem = Storage.prototype.setItem.bind(localStorage);
      Storage.prototype.setItem = function (storageKey, value) {
        if (storageKey === key) {
          throw new DOMException("full", "QuotaExceededError");
        }
        setItem(storageKey, value);
      };
    }, STORAGE_KEY);
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator("openclaw-community-invite-card");
      await card.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "visible" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("hides after a malformed cross-tab state update", async () => {
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

      await card.waitFor({ state: "detached" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("{");
    } finally {
      await context.close();
    }
  });
});
