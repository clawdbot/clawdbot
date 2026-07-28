// Shipped apps stamp `openclaw-native-nav`; current apps advertise web chrome
// at document start and stamp `openclaw-native-web-chrome` at document end.
// Plain browsers keep their normal in-page controls.
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

  async function openPage(options: { nativeNav?: boolean; webChrome?: boolean; width?: number }) {
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
    if (options.webChrome) {
      await page.addInitScript(() => {
        const nativeWindow = window as Window & {
          __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
          __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
        };
        nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
        nativeWindow["__OPENCLAW_NATIVE_HISTORY__"] = {
          canGoBack: false,
          canGoForward: false,
        };
        const stamp = () =>
          document.documentElement.classList.add(
            "openclaw-native-macos",
            "openclaw-native-web-chrome",
          );
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

    const toggle = page.locator(".shell-chrome-controls__nav-toggle");
    await expect.poll(() => toggle.isVisible()).toBe(true);
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Expand sidebar");
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
  });

  it("hides the web chrome cluster when the native titlebar toggle is present", async () => {
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

    // Expanded native-nav hosts keep the cluster's search (no native search
    // control exists while the rail is open) but hide the duplicate nav toggle.
    await expect.poll(() => page.locator(".shell-chrome-controls__search").isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".shell-chrome-controls__nav-toggle").isVisible())
      .toBe(false);

    // Collapse through the native titlebar path; the whole web chrome cluster
    // hides (native titlebar provides search and new-thread while collapsed).
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
    await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);
    // With the in-page expand control hidden, collapse anchors keyboard focus
    // on the content column instead of stranding it on the body.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-open-search"));
    });
    await expect.poll(() => page.locator(".cmd-palette-overlay").isVisible()).toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-new-session"));
    });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
  });

  it("hosts navigation, search, sessions, and history in web titlebar chrome", async () => {
    const page = await openPage({ webChrome: true });
    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);

    const back = toolbar.getByRole("button", { name: "Back" });
    const forward = toolbar.getByRole("button", { name: "Forward" });
    const search = toolbar.getByRole("button", { name: "Open command palette" });
    const newThread = toolbar.getByRole("button", { name: "New thread" });
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await expect.poll(() => search.isVisible()).toBe(true);
    await expect.poll(() => newThread.count()).toBe(0);

    await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    await expect.poll(() => newThread.isVisible()).toBe(true);
    await search.click();
    await expect.poll(() => page.locator(".cmd-palette-overlay").isVisible()).toBe(true);
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: true, canGoForward: false },
        }),
      );
    });
    await expect.poll(() => back.isDisabled()).toBe(false);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: false, canGoForward: true },
        }),
      );
    });
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(false);

    await newThread.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await toolbar.getByRole("button", { name: "Expand sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-collapsed");
  });

  it("keeps only history controls in the Settings titlebar", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);

    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => toolbar.getByRole("button").count()).toBe(2);
    await expect.poll(() => toolbar.getByRole("button", { name: "Back" }).isVisible()).toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Forward" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Expand sidebar" }).count())
      .toBe(0);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Open command palette" }).count())
      .toBe(0);
    await expect.poll(() => toolbar.getByRole("button", { name: "New thread" }).count()).toBe(0);
  });

  it("keeps the document root scroll-locked in the Settings takeover", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);
    await page.locator(".settings-sidebar").waitFor({ state: "visible" });

    // WKWebView scrolls the document whenever it overflows, dragging the
    // settings sidebar and content along. Force overflow the way stray
    // content would, then confirm the root refuses to move.
    const metrics = await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.append(spacer);
      window.scrollTo(0, 500);
      document.documentElement.scrollTop = 500;
      document.body.scrollTop = 500;
      return {
        bodyScrollTop: document.body.scrollTop,
        htmlScrollTop: document.documentElement.scrollTop,
        rootScrollY: window.scrollY,
      };
    });
    expect(metrics).toEqual({ bodyScrollTop: 0, htmlScrollTop: 0, rootScrollY: 0 });
  });

  it("moves drawer and search controls into the narrow chat title bar", async () => {
    const page = await openPage({ nativeNav: false, width: 900 });
    const header = page.locator(".chat-pane__header").first();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
    await expect
      .poll(() => header.getByRole("button", { name: "Expand sidebar" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => header.getByRole("button", { name: "Open command palette" }).isVisible())
      .toBe(true);
  });

  it("keeps the sidebar rail beside a half-width native link browser", async () => {
    const page = await openPage({ webChrome: true, width: 620 });
    await expect.poll(() => page.locator(".macos-titlebar-controls").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".sidebar-resizer").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".shell-nav").isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(false);

    await page.setViewportSize({ width: 560, height: 900 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await page.setViewportSize({ width: 620, height: 900 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".shell-nav").isVisible()).toBe(true);
  });

  it("uses the drawer below the native minimum main-pane width", async () => {
    const page = await openPage({ webChrome: true, width: 560 });
    await expect.poll(() => page.locator(".macos-titlebar-controls").isVisible()).toBe(false);
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(true);
    // The native traffic-light cluster ends around x=78. Keep the brand aligned
    // with the desktop titlebar controls' 92px inset so the groups stay distinct.
    await expect
      .poll(() =>
        page.locator(".topbar-brand").evaluate((element) => element.getBoundingClientRect().x),
      )
      .toBe(92);
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
