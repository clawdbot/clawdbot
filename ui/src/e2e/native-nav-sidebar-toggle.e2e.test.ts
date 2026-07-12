// The macOS app hosts a native titlebar sidebar toggle and stamps
// `openclaw-native-nav` on the document root (DashboardWindowController);
// the web UI must then hide its own expand/collapse buttons or every state
// shows two toggles. Plain browsers keep the web controls.
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

let browser: Browser;
let server: ControlUiE2eServer;
let context: BrowserContext | undefined;

describeControlUiE2e("Control UI native-nav sidebar toggle E2E", () => {
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

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openPage(options: { nativeNav: boolean; width?: number }) {
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: options.width ?? 1280 },
    });
    const page = await context.newPage();
    if (options.nativeNav) {
      // Mirrors the WKUserScript in DashboardWindowController.installNativeChromeScript,
      // which runs at document end. Playwright init scripts fire before
      // document.documentElement exists, so defer until the DOM is parsed.
      await page.addInitScript(() => {
        const nativeWindow = window as Window & {
          openclawNavMessages?: unknown[];
        };
        nativeWindow.openclawNavMessages = [];
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            messageHandlers: {
              openclawNav: {
                postMessage(message: unknown) {
                  nativeWindow.openclawNavMessages?.push(message);
                },
              },
            },
          },
        });
        const stamp = () =>
          document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-nav");
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      });
    }
    await installMockGateway(page);
    const response = await page.goto(server.baseUrl);
    expect(response?.status()).toBe(200);
    // The brand row only becomes visible on desktop widths; drawer widths keep
    // the sidebar hidden, so wait for DOM attachment instead of visibility.
    await page.locator(".sidebar-brand").waitFor({ state: "attached" });
    return page;
  }

  it("keeps the web expand/collapse controls in plain browsers", async () => {
    const page = await openPage({ nativeNav: false });

    const collapse = page.locator(".sidebar-brand__collapse");
    await expect.poll(() => collapse.isVisible()).toBe(true);
    await collapse.click();

    const expand = page.locator(".shell-nav-expand");
    await expect.poll(() => expand.isVisible()).toBe(true);
    await expand.click();
    await expect.poll(() => collapse.isVisible()).toBe(true);
  });

  it("hides both web toggles when the native titlebar toggle is present", async () => {
    const page = await openPage({ nativeNav: true });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const messages = (window as Window & { openclawNavMessages?: unknown[] })
            .openclawNavMessages;
          return messages?.find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { type?: string }).type === "nav-state",
          );
        }),
      )
      .toMatchObject({ type: "nav-state", collapsed: false });
    const initialWidth = await page.evaluate(() => {
      const messages = (window as Window & { openclawNavMessages?: unknown[] }).openclawNavMessages;
      const message = messages?.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { type?: string }).type === "nav-state",
      );
      return (message as { width?: number } | undefined)?.width ?? 0;
    });
    expect(initialWidth).toBeGreaterThan(0);

    await expect.poll(() => page.locator(".sidebar-brand__collapse").isVisible()).toBe(false);

    // Collapse through the native titlebar path; the floating expand control
    // must stay hidden (the titlebar button is the only expand affordance).
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & { openclawNavMessages?: Array<{ collapsed?: boolean }> }
          ).openclawNavMessages?.some((message) => message.collapsed === true),
        ),
      )
      .toBe(true);
    await expect.poll(() => page.locator(".shell-nav-expand").isVisible()).toBe(false);
    // With the in-page expand control hidden, collapse anchors keyboard focus
    // on the content column instead of stranding it on the body.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-open-search"));
    });
    await expect
      .poll(() => page.locator(".cmd-palette-overlay").getAttribute("open"))
      .not.toBeNull();

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-new-session"));
    });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
  });

  it("keeps the drawer hamburger at narrow widths in plain browsers", async () => {
    const page = await openPage({ nativeNav: false, width: 900 });
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(true);
  });

  it("hides the drawer hamburger at narrow widths when the native toggle is present", async () => {
    const page = await openPage({ nativeNav: true, width: 900 });
    // The native titlebar toggle drives the drawer via the window event, so
    // the web hamburger would be a duplicate control.
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(false);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    // Closing through the native toggle restores focus to the content anchor,
    // not the hidden hamburger the drawer recorded as its trigger.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-drawer-open");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);
  });
});
