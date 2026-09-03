// Shipped apps stamp `openclaw-native-nav`; current apps advertise web chrome
// at document start and stamp `openclaw-native-web-chrome` at document end.
// Plain browsers keep their normal in-page controls.
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  failNextDeviceIdentityMint,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native-nav sidebar toggle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
let TOAST_PROOF_DIR: string;
beforeEach(() => {
  TOAST_PROOF_DIR = createControlUiE2eArtifactDir("toast-layering");
});
const railProofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let railProofDir: string | undefined;
beforeEach(() => {
  railProofDir = railProofDirParent
    ? createControlUiE2eArtifactDir("native-nav-sidebar-toggle", railProofDirParent)
    : undefined;
});
const limitedScopes = ["operator.read", "operator.write"];
const UPDATE_AVAILABLE = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
} as const;
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
    beforeNavigate?: (page: Page) => Promise<void>;
    colorScheme?: "dark" | "light";
    deviceLess?: boolean;
    hasTouch?: boolean;
    height?: number;
    nativeNav?: boolean;
    pathname?: string;
    readySelector?: string;
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
      await installNativeWebChrome(page);
    }
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      ...options.scenario,
    });
    await options.beforeNavigate?.(page);
    const response = await page.goto(`${suite.server.baseUrl}${options.pathname ?? ""}`, {
      waitUntil: options.beforeNavigate ? "domcontentloaded" : "load",
    });
    expect(response?.status()).toBe(200);
    // The brand row only becomes visible on desktop widths; drawer widths keep
    // the sidebar hidden, so wait for DOM attachment instead of visibility.
    await page.locator(options.readySelector ?? ".sidebar-brand").waitFor({ state: "attached" });
    if (options.scenario) {
      await gateway.waitForRequest("sessions.list");
    }
    return page;
  }

  it("keeps the web expand/collapse controls in plain browsers", async () => {
    const page = await openPage({ nativeNav: false });

    expect(
      await page.evaluate(() => ({
        titlebarRegistered: customElements.get("openclaw-macos-titlebar-controls") !== undefined,
        titlebarRequested: performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("macos-titlebar-controls")),
      })),
    ).toEqual({ titlebarRegistered: false, titlebarRequested: false });
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("nav-drawer-swipe")),
      ),
    ).toBe(false);
    const collapse = page.locator(".sidebar-brand__collapse");
    await expect.poll(() => collapse.isVisible()).toBe(true);
    await collapse.click();
    const expand = page.locator(".shell-chrome-controls__nav-toggle");
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expand.click();
    await expect.poll(() => collapse.isVisible()).toBe(true);

    await page.locator(".sidebar-issues-button").click();
    const desktopInbox = page.locator("#sidebar-issues-panel");
    await desktopInbox.waitFor();
    await expect.poll(() => desktopInbox.getAttribute("aria-modal")).toBeNull();
    await page.keyboard.press("Escape");
  });

  it("closes navigation while the sidebar element is still unregistered", async () => {
    const testCase = {
      module: /\/assets\/app-sidebar-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
      pathname: "new",
      readySelector: ".new-session-page__message",
      tag: "openclaw-app-sidebar",
    };
    let held!: Awaited<ReturnType<typeof holdModuleResponse>>;
    const errors: string[] = [];
    try {
      const page = await openPage({
        ...testCase,
        width: 900,
        beforeNavigate: async (targetPage) => {
          targetPage.on("pageerror", (error) => errors.push(error.message));
          held = await holdModuleResponse(targetPage, testCase.module);
        },
      });
      await held.request;
      const element = page.locator(testCase.tag).first();
      expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
      const toggle = page.locator(".topbar-nav-toggle");
      const navigation = page.getByRole("dialog", { name: "Navigation" });
      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => navigation.isVisible()).toBe(false);
      expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();

      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => navigation.isVisible()).toBe(false);
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--mobile-nav");
      expect(errors).toEqual([]);

      held.release();
      await expect.poll(() => element.evaluate((node) => node.matches(":defined"))).toBe(true);
      await page.setViewportSize({ width: 900, height: 900 });
      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => navigation.isVisible()).toBe(false);
      expect(errors).toEqual([]);
      expect(held.requests()).toBe(1);
    } finally {
      held?.release();
    }
  });

  it.each(["navigation", "replacement open", "reconnection", "outside pointer", "Escape"] as const)(
    "keeps pending Inbox intent current across %s",
    async (action) => {
      const page = await openPage({ pathname: "new" });
      const held = await holdModuleResponse(
        page,
        /\/assets\/sidebar-attention-panel\.runtime-[^/?]+\.js(?:\?.*)?$/u,
      );
      const attention = await page
        .locator("openclaw-app-sidebar openclaw-sidebar-attention")
        .elementHandle();
      expect(attention).not.toBeNull();
      const inbox = page.locator("openclaw-app-sidebar .sidebar-issues-button");
      const dialog = page.getByRole("dialog", { name: "Inbox" });
      try {
        await inbox.click();
        const moduleUrl = await held.request;
        expect(await dialog.count()).toBe(0);
        if (action === "reconnection") {
          await attention!.evaluate((element) => {
            const parent = element.parentNode!;
            const next = element.nextSibling;
            element.remove();
            parent.insertBefore(element, next);
          });
        } else if (action === "outside pointer") {
          await page.locator(".new-session-page__message").click();
        } else if (action === "Escape") {
          await page.keyboard.press("Escape");
        } else {
          await page.getByRole("button", { name: "Collapse sidebar" }).click();
          await expect
            .poll(() => page.getByRole("button", { name: "Expand sidebar" }).isVisible())
            .toBe(true);
          // The native event does not generate an outside pointer that could
          // accidentally dismiss an Inbox resurrected by the old import.
          await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
          });
          await expect
            .poll(() => page.getByRole("button", { name: "Collapse sidebar" }).isVisible())
            .toBe(true);
          if (action === "replacement open") {
            await inbox.click();
          }
        }
        held.release();
        // Keep the import native: Vitest rewrites imports inside serialized callbacks.
        await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
        await attention!.evaluate(
          (element) =>
            (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
        );
        if (action !== "replacement open") {
          expect(await dialog.count()).toBe(0);
          expect(await inbox.getAttribute("aria-expanded")).toBe("false");
          await inbox.click();
        }
        await dialog.waitFor({ state: "visible" });
        await expect
          .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
        expect(held.requests()).toBe(1);
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.count()).toBe(0);
      } finally {
        held.release();
      }
    },
  );

  it("keeps restored sidebar focus from opening its tooltip", async () => {
    const page = await openPage({ hasTouch: true, nativeNav: false });
    const toggle = page.locator(".sidebar-brand__collapse");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");

    // Safari does not focus buttons on tap. Reproduce that ordering so the
    // shell's post-collapse focus, rather than the pointer itself, owns focus.
    await toggle.evaluate((element) => {
      for (const type of ["pointerdown", "pointerup"]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch" }));
      }
      (element as HTMLElement).click();
    });

    const expand = page.locator(".shell-chrome-controls__nav-toggle");
    const tooltip = expand.locator("xpath=..");
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => expand.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => tooltip.getAttribute("open")).toBeNull();

    await page.keyboard.press("Enter");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(await page.locator("openclaw-tooltip[open]").count()).toBe(0);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => expand.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => tooltip.getAttribute("open")).toBeNull();

    // A later, explicit keyboard return still reveals the accessible hint.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => tooltip.getAttribute("open")).toBe("");
    await page.keyboard.press("Enter");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(await page.locator("openclaw-tooltip[open]").count()).toBe(0);
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

    // Expanded native-nav hosts keep sidebar search (no native search control
    // exists while the rail is open) but hide the duplicate web nav toggle.
    await expect.poll(() => page.locator(".sidebar-brand__search").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".sidebar-brand__collapse").isVisible()).toBe(false);

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
    const page = await openPage({
      scenario: {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "update.run"],
        operatorScopes: ["operator.admin", "operator.read"],
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: {
          channel: "stable",
          autoEnabled: false,
          target: { kind: "package", version: "2.0.0" },
        },
      },
      webChrome: true,
    });
    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);
    const sidebarBrand = page.locator(".sidebar-brand");
    const sidebarNewThread = sidebarBrand.locator(".sidebar-brand__new-thread");
    await expect.poll(() => sidebarNewThread.isVisible()).toBe(true);
    await expect
      .poll(() =>
        sidebarNewThread.evaluate((element) => {
          const style = getComputedStyle(element);
          return { borderStyle: style.borderTopStyle, boxShadow: style.boxShadow };
        }),
      )
      .toEqual({ borderStyle: "none", boxShadow: "none" });
    await page.keyboard.press("Tab");
    await sidebarNewThread.focus();
    await expect
      .poll(() =>
        sidebarNewThread.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            focusVisible: element.matches(":focus-visible"),
            boxShadow: style.boxShadow,
          };
        }),
      )
      .toEqual({ focusVisible: true, boxShadow: expect.not.stringMatching(/^none$/) });
    await expect
      .poll(async () => {
        const [brandBox, newThreadBox] = await Promise.all([
          sidebarBrand.boundingBox(),
          sidebarNewThread.boundingBox(),
        ]);
        if (!brandBox || !newThreadBox) {
          return null;
        }
        return Math.round(brandBox.x + brandBox.width - (newThreadBox.x + newThreadBox.width));
      })
      .toBe(2);

    const back = toolbar.getByRole("button", { name: "Back" });
    const forward = toolbar.getByRole("button", { name: "Forward" });
    const search = toolbar.getByRole("button", { name: "Open command palette" });
    const newThread = toolbar.getByRole("button", { name: "New session" });
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await expect.poll(() => search.isVisible()).toBe(true);
    await expect.poll(() => newThread.count()).toBe(0);
    await page.locator(".sidebar-issues-button__count").waitFor();

    await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    await expect.poll(() => newThread.isVisible()).toBe(true);
    await page.locator(".sidebar-attention--floating .sidebar-issues-button").waitFor();
    const toolbarBox = await toolbar.boundingBox();
    const attention = page.locator(".sidebar-attention--floating");
    const attentionBox = await attention.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(attentionBox).not.toBeNull();
    expect(attentionBox!.x - (toolbarBox!.x + toolbarBox!.width)).toBeGreaterThanOrEqual(4);
    const titleBox = await page
      .locator(".chat-pane-cache__pane--visible .chat-pane__crumbs:visible")
      .first()
      .boundingBox();
    const attentionRight = await attention.evaluate((element) =>
      Math.max(
        ...[element, ...element.querySelectorAll("*")].map(
          (candidate) => candidate.getBoundingClientRect().right,
        ),
      ),
    );
    expect(titleBox).not.toBeNull();
    expect(titleBox!.x - attentionRight).toBeGreaterThanOrEqual(8);
    const topLeftControls = page.locator(
      ".macos-titlebar-controls button:visible, .sidebar-attention--floating button:visible",
    );
    const centerlines = await topLeftControls.evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    for (const centerline of centerlines.slice(1)) {
      expect(centerline).toBeCloseTo(centerlines[0]!, 1);
    }
    if (railProofDir) {
      await page.screenshot({
        animations: "disabled",
        path: path.join(railProofDir, "native-web-top-left-controls.png"),
      });
    }
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
    await panel.getByRole("button", { name: "Collapse" }).waitFor();

    const shellControls = page.locator(
      ".macos-titlebar-controls button:visible, .sidebar-attention--floating button:visible",
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
      await page.locator(".sidebar-attention--floating .sidebar-issues-button__count").waitFor();
      expect(await page.locator(".scope-upgrade-shell-status").count()).toBe(0);
    }
    for (let index = 0; index < (await panelControls.count()); index += 1) {
      await panelControls.nth(index).click({ trial: true });
    }
    if (railProofDir) {
      await page.screenshot({
        fullPage: true,
        path: path.join(
          railProofDir,
          `native-web-${testCase.deviceLess ? "limited" : "ordinary"}-${testCase.navCollapsed ? "collapsed" : "expanded"}.png`,
        ),
      });
    }
  });

  it("keeps overlay motion anchored to its owning interaction", async () => {
    const page = await openPage({ nativeNav: false });

    await page.keyboard.press("Meta+K");
    const palette = page.locator(".cmd-palette");
    const paletteDialog = page.locator("openclaw-modal-dialog.palette");
    await page.locator(".cmd-palette__input:not([disabled])").waitFor({ state: "visible" });
    const paletteAnimationName = await palette.evaluate(
      (element) => getComputedStyle(element).animationName,
    );
    const paletteDialogAnimationDuration = await paletteDialog.evaluate((element) => {
      const webAwesomeDialog = element.shadowRoot?.querySelector("wa-dialog");
      const dialog = webAwesomeDialog?.shadowRoot?.querySelector<HTMLElement>('[part~="dialog"]');
      return dialog ? getComputedStyle(dialog).animationDuration : "missing";
    });
    await page.keyboard.press("Escape");

    const sidebar = page.locator("openclaw-app-sidebar");
    await sidebar.locator(".sidebar-identity-card").click();
    const buildLink = sidebar.getByRole("link", {
      name: "Control UI build details",
      exact: true,
    });
    await page.clock.install();
    await buildLink.hover();
    await page.clock.runFor(600);
    const hoverCardMotion = await sidebar
      .locator("openclaw-sidebar-build-chip openclaw-tooltip")
      .evaluate((tooltip) => {
        const webAwesomeTooltip = tooltip.shadowRoot?.querySelector("wa-tooltip");
        const popup = webAwesomeTooltip?.shadowRoot?.querySelector("wa-popup");
        const popupSurface = popup?.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
        if (!popup || !popupSurface) {
          throw new Error("expected the open sidebar hovercard shadow parts");
        }
        const [originX, originY] = getComputedStyle(popupSurface)
          .transformOrigin.split(" ")
          .map(Number.parseFloat);
        return {
          animationDuration: getComputedStyle(popupSurface).animationDuration,
          popupHeight: popupSurface.offsetHeight,
          popupWidth: popupSurface.offsetWidth,
          originX,
          originY,
          placement: popup.getAttribute("data-current-placement"),
        };
      });
    await page.clock.resume();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 900, height: 900 });
    const drawer = page.locator(".shell-nav.nav-drawer");
    await expect.poll(() => drawer.count()).toBe(1);
    await page.locator(".chat-pane__nav-toggle:visible").first().click();
    const drawerAnimationName = await drawer.evaluate(
      (element) => getComputedStyle(element).animationName,
    );

    expect(paletteAnimationName).toBe("none");
    expect(paletteDialogAnimationDuration).toBe("0s");
    expect(drawerAnimationName).toBe("none");
    expect(hoverCardMotion.animationDuration).toBe("0.14s");
    expect(hoverCardMotion.placement).toMatch(/^top(?:-|$)/u);
    expect(hoverCardMotion.originX).toBeGreaterThan(hoverCardMotion.popupWidth * 0.45);
    expect(hoverCardMotion.originX).toBeLessThan(hoverCardMotion.popupWidth * 0.55);
    expect(hoverCardMotion.originY).toBeGreaterThan(hoverCardMotion.popupHeight * 0.95);
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
    await expect.poll(() => page.locator(".shell-nav-backdrop").count()).toBe(1);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".shell-nav") !== null))
      .toBe(false);

    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Expand sidebar");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect.poll(readFocusLocation).toBe("navigation");

    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".shell-nav-backdrop").getAttribute("aria-hidden"))
      .toBe("true");
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

    const pageDetails = page.locator(".chat-controls__model-picker").first();
    await pageDetails.evaluate((element) => ((element as HTMLDetailsElement).open = true));
    await expect.poll(() => pageDetails.getAttribute("open")).toBe("");
    await page.keyboard.press("Escape");
    await expect.poll(() => pageDetails.getAttribute("open")).toBe("");
    await expect.poll(() => dialog.isVisible()).toBe(false);

    await trigger.click();
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
    const inbox = navigation.locator(".sidebar-issues-button");
    await inbox.click();
    const attentionDialog = page.getByRole("dialog", { name: "Inbox" });
    await attentionDialog.waitFor();
    await expect.poll(() => attentionDialog.getAttribute("aria-modal")).toBe("true");
    const attentionControls = attentionDialog.locator("button, a[href], summary");
    const lastAttentionControl = attentionControls.last();
    await lastAttentionControl.focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest("#sidebar-issues-panel") !== null),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => attentionDialog.count()).toBe(0);
    await expect.poll(() => dialog.isVisible()).toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:debug-overlay-request"));
    });
    const debugOverlay = page.locator(".debug-overlay");
    await debugOverlay.waitFor();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(() => debugOverlay.count()).toBe(0);

    await trigger.click();
    await page.mouse.click(899, 450);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await trigger.click();
    await navigation.locator(".sidebar-issues-button").click();
    await attentionDialog.waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => attentionDialog.count()).toBe(0);
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
    await expect.poll(() => navigation.getAttribute("class")).not.toContain("nav-drawer");
  });

  it.each([
    {
      colorScheme: "dark",
      finalLayout: "compact",
      finalViewport: { height: 844, width: 390 },
    },
    {
      colorScheme: "light",
      finalLayout: "desktop",
      finalViewport: { height: 900, width: 1280 },
    },
  ] as const)(
    "keeps drawer toast actionable and handed-off toast clear of chat chrome in $finalLayout $colorScheme mode",
    async ({ colorScheme, finalLayout, finalViewport }) => {
      const page = await openPage({
        colorScheme,
        height: 844,
        nativeNav: false,
        scenario: TOAST_SCENARIO,
        width: 390,
      });
      const drawer = page.locator(".shell-nav.nav-drawer");
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
      const drawerToastGeometry = await host.evaluate((node) => {
        const toastElement = node.querySelector<HTMLElement>(".app-toast");
        return {
          computedTop: toastElement
            ? Math.round(Number.parseFloat(getComputedStyle(toastElement).top))
            : null,
          placement: node.dataset.toastPlacement,
        };
      });
      expect(drawerToastGeometry.placement).toBe("overlay");
      expect(drawerToastGeometry.computedTop).toBe(20);
      const dismiss = toast.getByRole("button", { name: "Dismiss" });
      await dismiss.click({ trial: true });

      await page.screenshot({
        animations: "disabled",
        path: path.join(TOAST_PROOF_DIR, `mobile-drawer-toast-${colorScheme}.png`),
      });
      if (finalLayout === "compact") {
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.isVisible()).toBe(false);
      } else {
        await page.setViewportSize(finalViewport);
        await expect.poll(() => drawer.count()).toBe(0);
      }
      expect(page.viewportSize()).toEqual(finalViewport);
      const retainedHost = page.locator(".shell > openclaw-toast-host");
      await expect.poll(() => retainedHost.getAttribute("data-toast-placement")).toBe("shell");
      const retainedToast = retainedHost.locator(".app-toast");
      await expect.poll(() => retainedToast.textContent()).toContain("Codex hidden");
      if (finalLayout === "compact") {
        await expect
          .poll(async () => {
            const [toastBounds, headerBounds] = await Promise.all([
              retainedToast.boundingBox(),
              page.locator(".chat-pane__header:visible").first().boundingBox(),
            ]);
            return Boolean(
              toastBounds && headerBounds && toastBounds.y >= headerBounds.y + headerBounds.height,
            );
          })
          .toBe(true);
      } else {
        await expect
          .poll(async () => Math.round((await retainedToast.boundingBox())?.y ?? -1))
          .toBe(20);
      }
      await expect
        .poll(async () => {
          const [toastBounds, composerBounds] = await Promise.all([
            retainedToast.boundingBox(),
            page.locator(".agent-chat__composer-shell").boundingBox(),
          ]);
          return Boolean(
            toastBounds && composerBounds && toastBounds.y + toastBounds.height < composerBounds.y,
          );
        })
        .toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(TOAST_PROOF_DIR, `handed-off-toast-${finalLayout}-${colorScheme}.png`),
      });
      await retainedToast.getByRole("button", { name: "Dismiss" }).click();
      await expect.poll(() => retainedToast.isVisible()).toBe(false);
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
