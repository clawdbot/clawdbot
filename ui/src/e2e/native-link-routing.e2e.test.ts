// Real-browser proof for native-host link routing and the bridge-free browser path.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/native-link-routing");

let server: ControlUiE2eServer;
const openBrowsers = new Set<Browser>();

async function newBrowserContext(): Promise<BrowserContext> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  openBrowsers.add(browser);
  return browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}

async function closeBrowsers(): Promise<void> {
  await Promise.all([...openBrowsers].map((browser) => browser.close().catch(() => {})));
  openBrowsers.clear();
}

describeControlUiE2e("native link routing", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    fs.mkdirSync(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await closeBrowsers();
    await server?.close();
  });

  afterEach(closeBrowsers);

  it("shows native actions and posts inline or external targets", async () => {
    const context = await newBrowserContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(server.baseUrl).origin,
    });
    await context.route("https://example.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Report</title>" }),
    );
    await context.addInitScript(() => {
      const messages: unknown[] = [];
      const host = window as Window & {
        openclawNativeLinkMessages?: unknown[];
        webkit?: unknown;
      };
      host.openclawNativeLinkMessages = messages;
      host.webkit = {
        messageHandlers: {
          openclawLink: { postMessage: (message: unknown) => messages.push(message) },
        },
      };
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            {
              type: "text",
              text: [
                "Read the [report](https://example.com/report),",
                "open [Usage](/usage), or inspect `README.md:1`.",
              ].join(" "),
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${server.baseUrl}chat`);
    const link = page.getByRole("link", { name: "report" });

    await link.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { openclawNativeLinkMessages?: unknown[] })
              .openclawNativeLinkMessages,
        ),
      )
      .toEqual([{ type: "open-link", url: "https://example.com/report", target: "inline" }]);

    const bubble = page.locator(".chat-bubble");
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();
    await bubble.click({
      button: "right",
      position: { x: bubbleBox!.width - 8, y: bubbleBox!.height - 8 },
    });
    const replyMenu = page.getByRole("menu", { name: "Message actions" });
    await expect.poll(() => replyMenu.isVisible()).toBe(true);
    await page.evaluate(() => new Promise(requestAnimationFrame));

    await link.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Link actions" });
    await expect.poll(() => menu.isVisible()).toBe(true);
    await expect.poll(() => replyMenu.count()).toBe(0);
    await expect
      .poll(() => menu.locator(".session-menu__text").allTextContents())
      .toEqual(["Open in Sidebar", "Open in Default Browser", "Copy Link"]);
    await page.screenshot({
      path: path.join(artifactDir, "01-native-link-menu-page.jpg"),
      type: "jpeg",
      quality: 60,
    });
    await menu.getByRole("menuitem", { name: "Open in Default Browser" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { openclawNativeLinkMessages?: unknown[] })
              .openclawNativeLinkMessages,
        ),
      )
      .toEqual([
        { type: "open-link", url: "https://example.com/report", target: "inline" },
        { type: "open-link", url: "https://example.com/report", target: "external" },
      ]);

    await link.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy Link" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("https://example.com/report");

    const popupPromise = page.waitForEvent("popup");
    await link.click({ modifiers: ["Meta"] });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://example.com/report");
    await popup.close();

    await page.evaluate(async () => {
      await customElements.whenDefined("openclaw-modal-dialog");
      const dialog = document.createElement("openclaw-modal-dialog");
      dialog.id = "native-link-routing-modal";
      dialog.setAttribute("label", "Link routing test");
      const anchor = document.createElement("a");
      anchor.href = "https://example.com/modal-report";
      anchor.textContent = "modal report";
      dialog.append(anchor);
      document.body.append(dialog);
    });
    const modalLink = page.getByRole("link", { name: "modal report" });
    await modalLink.click({ button: "right" });
    await expect.poll(() => menu.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.count()).toBe(0);
    await expect
      .poll(() =>
        page.locator("#native-link-routing-modal").evaluate((modal) => {
          return modal.shadowRoot?.querySelector("dialog")?.open ?? false;
        }),
      )
      .toBe(true);
    await modalLink.click({ button: "right" });
    await expect.poll(() => menu.isVisible()).toBe(true);
    await menu.getByRole("menuitem", { name: "Open in Sidebar" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { openclawNativeLinkMessages?: unknown[] })
              .openclawNativeLinkMessages,
        ),
      )
      .toContainEqual({
        type: "open-link",
        url: "https://example.com/modal-report",
        target: "inline",
      });
    await page.evaluate(() => {
      document.querySelector("#native-link-routing-modal")?.remove();
    });

    await page.getByRole("link", { name: "Usage" }).click({ button: "right" });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
    const messageMenu = page.getByRole("menu", { name: "Message actions" });
    await expect.poll(() => messageMenu.isVisible()).toBe(true);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.keyboard.press("Escape");
    await expect.poll(() => messageMenu.count()).toBe(0);
    await page.locator('a.markdown-file-link[data-file-path="README.md"]').click({
      button: "right",
    });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
  });

  it("keeps ordinary browser navigation when the native bridge is absent", async () => {
    const context = await newBrowserContext();
    await context.route("https://example.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Report</title>" }),
    );
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Read the [report](https://example.com/report)." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${server.baseUrl}chat`);
    const link = page.getByRole("link", { name: "report" });

    await link.click({ button: "right" });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://example.com/report");
  });
});
