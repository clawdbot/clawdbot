import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
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
const captureVideo = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function traceInviteMounts(page: Page) {
  await page.addInitScript(() => {
    const trace = { mounts: 0 };
    const seen = new WeakSet<Element>();
    (window as Window & { communityInviteTrace?: typeof trace }).communityInviteTrace = trace;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            for (const card of [node, ...node.querySelectorAll("openclaw-community-invite-card")]) {
              if (card.localName === "openclaw-community-invite-card" && !seen.has(card)) {
                seen.add(card);
                trace.mounts += 1;
              }
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () =>
        (window as Window & { communityInviteTrace?: { mounts: number } }).communityInviteTrace
          ?.mounts ?? 0,
    );
}

async function waitForInvitePolicy(page: Page, enabled: boolean) {
  await page.waitForFunction((expected) => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          runtime?: {
            context: {
              config: { current: { serverVersion: string | null; communityInvite: boolean } };
            };
          };
        })
      | null;
    const config = app?.runtime?.context.config.current;
    return config?.serverVersion != null && config.communityInvite === expected;
  }, enabled);
}

async function settleSidebarIdleWork(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(
          () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          { timeout: 3000 },
        );
      }),
  );
}

suite.define(() => {
  it("honors deployment policy before showing and preserves browser dismissals", async () => {
    const artifactDir = createControlUiE2eArtifactDir("community-invite-policy");
    const viewport = { height: 900, width: 1280 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureVideo ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const mountedInvites = await traceInviteMounts(page);
    await installMockGateway(page);
    let communityInvite = false;
    let releaseBootstrap!: () => void;
    const bootstrapReady = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const imageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("community-art/")) {
        imageRequests.push(request.url());
      }
    });
    await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
      await bootstrapReady;
      await route.fulfill({
        json: { ...createControlUiMockBootstrapConfig(), communityInvite },
      });
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await page.locator(".sidebar-shell__footer").waitFor();
      const card = page.locator("openclaw-community-invite-card");
      await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(imageRequests).toEqual([]);
      await page.screenshot({ path: path.join(artifactDir, "01-awaiting-policy.png") });
      const bootstrapResponse = page.waitForResponse(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
      releaseBootstrap();
      await bootstrapResponse;
      await waitForInvitePolicy(page, false);
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(imageRequests).toEqual([]);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
      const pet = page.locator("openclaw-lobster-pet");
      const footer = page.locator(".sidebar-shell__footer");
      const petBox = await pet.boundingBox();
      const footerBox = await footer.boundingBox();
      if (!petBox || !footerBox) {
        throw new Error("Sidebar pet and footer must have rendered bounds");
      }
      expect(petBox.height).toBe(52);
      expect(Math.abs(petBox.y + petBox.height - footerBox.y - 3)).toBeLessThan(0.5);
      await page.screenshot({ path: path.join(artifactDir, "02-disabled.png") });

      communityInvite = true;
      await page.reload();
      await waitForInvitePolicy(page, true);
      await card.waitFor({ state: "visible" });
      await card.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      await expect
        .poll(() => card.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await page.screenshot({ path: path.join(artifactDir, "03-enabled.png") });
      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      const dismissal = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      expect(dismissal).not.toBeNull();

      for (const enabled of [false, true]) {
        communityInvite = enabled;
        await page.reload();
        await waitForInvitePolicy(page, enabled);
        await page.locator(".sidebar-shell__footer").waitFor();
        await settleSidebarIdleWork(page);
        expect(await card.count()).toBe(0);
        expect(await mountedInvites()).toBe(0);
        expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
          dismissal,
        );
      }
      await page.screenshot({ path: path.join(artifactDir, "04-dismissal-preserved.png") });
    } finally {
      releaseBootstrap();
      await suite.closeBrowserContext(context);
    }
  });

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

  it("dismisses for this page and reports when the preference cannot be saved", async () => {
    const artifactDir = createControlUiE2eArtifactDir("community-invite-storage-failure");
    const viewport = { height: 900, width: 1280 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureVideo ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const mountedInvites = await traceInviteMounts(page);
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
      await card.waitFor({ state: "detached" });
      await page
        .getByText("Invitation dismissed, but your preference couldn't be saved.")
        .waitFor();
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
      expect(await mountedInvites()).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "01-dismissed-with-warning.png") });

      await page.keyboard.press("Control+Shift+,");
      await waitForControlUiSettingsTakeover(page);
      await page.keyboard.press("Escape");
      await page.locator(".sidebar-shell__footer").waitFor();
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(1);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
      await page.screenshot({ path: path.join(artifactDir, "02-hidden-after-settings.png") });
    } finally {
      await suite.closeBrowserContext(context);
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
