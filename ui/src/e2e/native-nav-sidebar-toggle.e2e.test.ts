// Shipped apps stamp `openclaw-native-nav`; current apps advertise web chrome
// at document start and stamp `openclaw-native-web-chrome` at document end.
// Plain browsers keep their normal in-page controls.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { afterEach, expect, it } from "vitest";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  failNextDeviceIdentityMint,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native-nav sidebar toggle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const TOAST_PROOF_DIR = path.resolve(".artifacts/control-ui-e2e/toast-layering");
const railProofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const limitedScopes = ["operator.read", "operator.write"];
const TOAST_SCENARIO: ControlUiMockGatewayScenario = {
  featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
  methodResponses: {
    "sessions.list": chatSessionListResponse(),
    "sessions.catalog.list": {
      catalogs: [
        {
          id: "codex",
          label: "Codex",
          capabilities: { archive: true, continueSession: true },
          hosts: [
            {
              connected: true,
              hostId: "gateway:local",
              kind: "gateway",
              label: "Local Codex",
              sessions: [
                {
                  archived: false,
                  canArchive: true,
                  canContinue: true,
                  name: "Toast routing proof",
                  status: "idle",
                  threadId: "toast-routing-proof",
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

let context: BrowserContext | undefined;

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openPage(options: {
    colorScheme?: "dark" | "light";
    deviceLess?: boolean;
    hasTouch?: boolean;
    height?: number;
    nativeNav?: boolean;
    scenario?: ControlUiMockGatewayScenario;
    webChrome?: boolean;
    width?: number;
  }) {
    context = await suite.browser.newContext({
      colorScheme: options.colorScheme,
      hasTouch: options.hasTouch,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: options.height ?? 900, width: options.width ?? 1280 },
    });
    const page = await context.newPage();
    if (options.deviceLess) {
      await failNextDeviceIdentityMint(page);
    }
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
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      ...options.scenario,
    });
    const response = await page.goto(suite.server.baseUrl);
    expect(response?.status()).toBe(200);
    // The brand row only becomes visible on desktop widths; drawer widths keep
    // the sidebar hidden, so wait for DOM attachment instead of visibility.
    await page.locator(".sidebar-brand").waitFor({ state: "attached" });
    if (options.scenario) {
      await gateway.waitForRequest("sessions.list");
    }
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

  it("keeps pointer-triggered sidebar focus from opening its tooltip", async () => {
    const page = await openPage({ hasTouch: true, nativeNav: false });
    const toggle = page.locator(".shell-chrome-controls__nav-toggle");
    const tooltip = toggle.locator("xpath=..").locator("wa-tooltip");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");

    // Safari does not focus buttons on tap. Reproduce that ordering so the
    // shell's post-collapse focus, rather than the pointer itself, owns focus.
    await toggle.evaluate((element) => {
      for (const type of ["pointerdown", "pointerup"]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch" }));
      }
      (element as HTMLElement).click();
    });

    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => toggle.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => tooltip.getAttribute("open")).toBeNull();
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
    const newThread = toolbar.getByRole("button", { name: "New session" });
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

  it.each([
    {
      deviceLess: false,
      label: "ordinary collapsed-navigation",
      navCollapsed: true,
      operatorScopes: undefined,
      width: 1280,
    },
    {
      deviceLess: true,
      label: "limited-access collapsed-navigation",
      navCollapsed: true,
      operatorScopes: limitedScopes,
      width: 1280,
    },
    {
      deviceLess: true,
      label: "limited-access expanded-navigation",
      navCollapsed: false,
      operatorScopes: limitedScopes,
      width: 620,
    },
  ])("keeps expanded side-panel tabs clear of $label web titlebar chrome", async (testCase) => {
    const page = await openPage({
      deviceLess: testCase.deviceLess,
      scenario: testCase.operatorScopes
        ? {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "device.scopes.requestUpgrade",
              "device.scopes.waitUpgrade",
              "sessions.create",
            ],
            methodResponses: { "sessions.list": chatSessionListResponse() },
            operatorScopes: testCase.operatorScopes,
          }
        : undefined,
      webChrome: true,
      width: testCase.width,
    });
    const toolbar = page.locator(".macos-titlebar-controls");
    if (testCase.navCollapsed) {
      await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    }
    await openChatSidePanelType(page, "Side chat");
    const panel = page.getByRole("region", { name: "Side panel" });
    await panel.getByRole("button", { name: "Expand side panel" }).click();
    await panel.getByRole("button", { name: "Restore side panel" }).waitFor();

    const shellControls = page.locator(
      ".macos-titlebar-controls button:visible, .scope-upgrade-shell-status:visible",
    );
    const panelControls = panel.locator(":scope > .side-panel__header :is(button, wa-tab):visible");
    const shellBoxes = await Promise.all(
      Array.from({ length: await shellControls.count() }, (_, index) =>
        shellControls.nth(index).boundingBox(),
      ),
    );
    const panelBoxes = await Promise.all(
      Array.from({ length: await panelControls.count() }, (_, index) =>
        panelControls.nth(index).boundingBox(),
      ),
    );
    const shellRight = Math.max(...shellBoxes.flatMap((box) => (box ? [box.x + box.width] : [])));
    const panelLeft = Math.min(...panelBoxes.flatMap((box) => (box ? [box.x] : [])));
    expect(panelLeft - shellRight).toBeGreaterThanOrEqual(4);
    expect(panelLeft - shellRight).toBeLessThanOrEqual(16);
    if (testCase.deviceLess) {
      await page.locator(".scope-upgrade-shell-status").waitFor();
    }
    for (let index = 0; index < (await panelControls.count()); index += 1) {
      await panelControls.nth(index).click({ trial: true });
    }
    if (railProofDir) {
      await mkdir(railProofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(
          railProofDir,
          `native-web-${testCase.deviceLess ? "limited" : "ordinary"}-${testCase.navCollapsed ? "collapsed" : "expanded"}.png`,
        ),
      });
    }
  });

  it("keeps only history controls in the Settings titlebar", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
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
    await expect.poll(() => toolbar.getByRole("button", { name: "New session" }).count()).toBe(0);
  });

  it("keeps the document root scroll-locked in the Settings takeover", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
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

  it("keeps drawer and search reachable from the narrow chat title bar", async () => {
    const page = await openPage({ nativeNav: false, width: 900 });
    const header = page.locator(".chat-pane__header").first();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
    await expect
      .poll(() => header.getByRole("button", { name: "Expand sidebar" }).isVisible())
      .toBe(true);
    await expect.poll(() => header.locator(".chat-pane__palette-open").count()).toBe(0);
    await header.locator(".chat-header-session-menu__trigger").click();
    await page.getByText("Open command palette", { exact: true }).click();
    await page.locator(".cmd-palette__input").waitFor({ state: "visible" });
  });

  it("keeps the mobile drawer modal, keyboard-contained, and focus-restoring", async () => {
    const page = await openPage({
      nativeNav: false,
      scenario: {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      },
      width: 900,
    });
    const navigation = page.locator(".shell-nav");
    const drawer = navigation.locator("openclaw-modal-dialog.nav-drawer");
    const dialog = page.getByRole("dialog", { name: "Navigation" });
    const trigger = page.locator(".chat-pane__nav-toggle").first();
    const readFocusLocation = () =>
      page.evaluate(() => {
        // Native dialog tab order may hand focus to browser chrome when no document candidate remains.
        // `document.hasFocus()` distinguishes that from focus on the underlying inert page.
        if (!document.hasFocus()) {
          return "browser-chrome";
        }
        return document.activeElement?.closest(".shell-nav") ? "navigation" : "page";
      });

    await expect.poll(() => navigation.getAttribute("inert")).toBe("");
    await expect.poll(() => page.locator(".shell-nav-backdrop").count()).toBe(0);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".shell-nav") !== null))
      .toBe(false);

    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Expand sidebar");
    await trigger.focus();
    const afterShowMarker = "data-e2e-after-show";
    await drawer.evaluate((element, marker) => {
      element.removeAttribute(marker);
      element.addEventListener("wa-after-show", () => element.setAttribute(marker, ""), {
        once: true,
      });
    }, afterShowMarker);
    await page.keyboard.press("Enter");
    await expect.poll(() => drawer.getAttribute(afterShowMarker)).toBe("");
    await expect.poll(readFocusLocation).toBe("navigation");

    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Collapse sidebar");

    for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"] as const) {
      await page.keyboard.press(key);
      await expect.poll(readFocusLocation).not.toBe("page");
    }

    expect(
      await page.locator("#control-ui-main").evaluate((element) => {
        element.focus();
        return element === document.activeElement;
      }),
    ).toBe(false);

    const row = navigation.locator(".sidebar-recent-session").first();
    await row.hover();
    await row.getByRole("button", { name: "Open session menu" }).click();
    const sessionMenu = page.getByRole("menu", { name: /Actions for/ });
    await expect.poll(() => sessionMenu.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => sessionMenu.count()).toBe(0);
    await expect.poll(() => dialog.isVisible()).toBe(true);

    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-drawer-open");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await trigger.click();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await page.mouse.click(899, 450);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
    await expect.poll(() => drawer.count()).toBe(0);
  });

  it.each(["dark", "light"] as const)(
    "keeps the toast above the mobile drawer in %s mode",
    async (colorScheme) => {
      const page = await openPage({
        colorScheme,
        height: 844,
        nativeNav: false,
        scenario: TOAST_SCENARIO,
        width: 390,
      });
      const drawer = page.locator("openclaw-modal-dialog.nav-drawer");
      const dialog = page.getByRole("dialog", { name: "Navigation" });
      await page.locator(".chat-pane__nav-toggle").first().click();
      await expect.poll(() => dialog.isVisible()).toBe(true);

      const catalog = drawer.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      await catalog.locator(".sidebar-recent-sessions__head").hover();
      await catalog.locator('[data-session-catalog-view-menu="codex"]').click();
      await page
        .locator('wa-dropdown-item[value="hide-catalog"]')
        .evaluate((element) => (element as HTMLElement).click());
      const host = drawer.locator("openclaw-toast-host");
      const toast = host.locator(".app-toast");
      await toast.waitFor();
      await expect.poll(() => toast.textContent()).toContain("Codex hidden");
      const dismiss = toast.getByRole("button", { name: "Dismiss" });
      await dismiss.click({ trial: true });

      await page.screenshot({
        animations: "disabled",
        path: path.join(TOAST_PROOF_DIR, `mobile-drawer-toast-${colorScheme}.png`),
      });
      if (colorScheme === "dark") {
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.isVisible()).toBe(false);
      } else {
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect.poll(() => drawer.count()).toBe(0);
      }
      const handedOffToast = page.locator(".shell > openclaw-toast-host .app-toast");
      await expect.poll(() => handedOffToast.textContent()).toContain("Codex hidden");
      const [toastBounds, composerBounds] = await Promise.all([
        handedOffToast.boundingBox(),
        page.locator(".agent-chat__composer-shell").boundingBox(),
      ]);
      if (!toastBounds || !composerBounds) {
        throw new Error("expected the handed-off toast and chat composer to have layout boxes");
      }
      expect(Math.round(toastBounds.y)).toBe(20);
      expect(toastBounds.y + toastBounds.height).toBeLessThan(composerBounds.y);
      await handedOffToast.getByRole("button", { name: "Dismiss" }).click();
      await expect.poll(() => handedOffToast.isVisible()).toBe(false);
    },
  );

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
