import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native titlebar startup E2E",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});
const railProofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const nativeTitlebarChunk = /\/assets\/macos-titlebar-controls\.runtime-[^/?]+\.js(?:\?.*)?$/u;

suite.define(() => {
  async function openPage(options: {
    beforeNavigate: (page: Page) => Promise<void>;
    pathname?: string;
    readySelector?: string;
    webChrome: boolean;
  }) {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(railProofDir
        ? { recordVideo: { dir: railProofDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    if (options.webChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
    });
    await options.beforeNavigate(page);
    const response = await page.goto(`${suite.server.baseUrl}${options.pathname ?? ""}`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await page.locator(options.readySelector ?? ".sidebar-brand").waitFor({ state: "attached" });
    return page;
  }

  it("keeps native titlebar state and actions current while its chunk is loading", async () => {
    let held: Awaited<ReturnType<typeof holdModuleResponse>> | undefined;
    const errors: string[] = [];
    try {
      const page = await openPage({
        webChrome: true,
        beforeNavigate: async (targetPage) => {
          targetPage.on("pageerror", (error) => errors.push(error.message));
          held = await holdModuleResponse(targetPage, nativeTitlebarChunk);
        },
      });
      await held!.request;
      const element = page.locator("openclaw-macos-titlebar-controls");
      expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:native-history-state", {
            detail: { canGoBack: true, canGoForward: false },
          }),
        );
        window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
      });
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");
      if (railProofDir) {
        await mkdir(railProofDir, { recursive: true });
        await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loading.png") });
      }

      held!.release();
      const toolbar = page.locator(".macos-titlebar-controls");
      await toolbar.waitFor({ state: "visible" });
      await expect
        .poll(() => toolbar.getByRole("button", { name: "Back" }).isDisabled())
        .toBe(false);
      await expect
        .poll(() => toolbar.getByRole("button", { name: "Forward" }).isDisabled())
        .toBe(true);
      await toolbar.getByRole("button", { name: "New session", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(held!.requests()).toBe(1);
      expect(errors).toEqual([]);
      if (railProofDir) {
        await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loaded.png") });
      }
    } finally {
      held?.release();
    }
  });

  it.each([
    {
      name: "native titlebar",
      chunk: nativeTitlebarChunk,
      label: "openclaw-macos-titlebar-controls",
      webChrome: true,
      pathname: "",
      readySelector: ".sidebar-brand",
      proofName: "native-titlebar",
    },
    {
      name: "floating sidebar attention",
      chunk: /\/assets\/sidebar-attention-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
      label: "sidebar-attention",
      webChrome: false,
      pathname: "settings/appearance",
      readySelector: ".shell--settings",
      proofName: "sidebar-attention",
    },
  ])("recovers $name visibly after its chunk fails", async (testCase) => {
    let chunkRequests = 0;
    let headRequests = 0;
    const page = await openPage({
      webChrome: testCase.webChrome,
      pathname: testCase.pathname,
      readySelector: testCase.readySelector,
      beforeNavigate: async (targetPage) => {
        await targetPage.route("**/*", async (route) => {
          if (route.request().method() === "HEAD" && ++headRequests === 1) {
            await route.fulfill({ status: 503 });
          } else {
            await route.fallback();
          }
        });
        await targetPage.route(testCase.chunk, async (route) => {
          if (++chunkRequests === 1) {
            await route.abort("internetdisconnected");
          } else {
            await route.fallback();
          }
        });
      },
    });
    const error = page.locator(".lazy-view-error");
    await error.waitFor({ state: "visible" });
    expect(await error.textContent()).toContain(testCase.label);
    expect(await error.textContent()).toContain("Failed to fetch dynamically imported module");
    await expect.poll(() => headRequests).toBe(1);
    expect(chunkRequests).toBe(1);
    if (railProofDir) {
      await mkdir(railProofDir, { recursive: true });
      await page.screenshot({ path: path.join(railProofDir, `${testCase.proofName}-failed.png`) });
    }

    const reloaded = page.waitForEvent("domcontentloaded");
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await reloaded;
    if (testCase.webChrome) {
      const toolbar = page.locator(".macos-titlebar-controls");
      await toolbar.waitFor({ state: "visible" });
      await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
      await toolbar.getByRole("button", { name: "New session", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
    } else {
      await page.locator(".sidebar-attention--floating .sidebar-issues-button").click();
      await page.locator("#sidebar-issues-panel").waitFor({ state: "visible" });
    }
    expect(await error.count()).toBe(0);
    expect(chunkRequests).toBe(2);
    if (railProofDir) {
      await page.screenshot({
        path: path.join(railProofDir, `${testCase.proofName}-recovered.png`),
      });
    }
  });
});
