/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../components/github-link-hovercard-registration.ts";
import type { GitHubLinkHovercardProvider } from "../components/github-link-hovercard.runtime.ts";
import "../components/modal-dialog.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { postNativeUpdate, startNativeLinkRouting } from "./native-link-routing.ts";

const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";

type NativeLinkRouting = ReturnType<typeof startNativeLinkRouting>;

type NativeMessage = { type: string; url: string; target: string };

let routing: NativeLinkRouting | undefined;
let stopBrowserListener: (() => void) | undefined;

afterEach(() => {
  routing?.dispose();
  routing = undefined;
  stopBrowserListener?.();
  stopBrowserListener = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function installBridge() {
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn((message: NativeMessage) => messages.push(message));
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawLink: { postMessage }, openclawBrowser: { postMessage: vi.fn() } },
  });
  const browserRequests: BrowserPanelToggleDetail[] = [];
  const listener = (event: Event) =>
    browserRequests.push((event as CustomEvent<BrowserPanelToggleDetail>).detail);
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  stopBrowserListener = () => window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  return { messages, postMessage, browserRequests };
}

function appendLink(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  document.body.append(anchor);
  return anchor;
}

function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  anchor.dispatchEvent(event);
  return event;
}

function clickWithoutNavigation(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  let defaultPrevented: boolean | undefined;
  const preventNavigation = (event: MouseEvent) => {
    defaultPrevented = event.defaultPrevented;
    event.preventDefault();
  };
  // Observe after the native router, then suppress jsdom's default navigation.
  window.addEventListener("click", preventNavigation, { once: true });
  try {
    click(anchor, init);
    return defaultPrevented;
  } finally {
    window.removeEventListener("click", preventNavigation);
  }
}

function contextMenu(anchor: HTMLAnchorElement) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 2,
    clientX: 120,
    clientY: 140,
  });
  anchor.dispatchEvent(event);
  return event;
}

async function waitForMenu() {
  await vi.waitFor(() =>
    expect(document.querySelector("openclaw-native-link-menu")).not.toBeNull(),
  );
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.querySelector(".session-menu__text")?.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

describe("native link routing", () => {
  it.each(["abort", "dispose"] as const)(
    "cancels a pending context menu on %s and removes link handlers",
    async (stop) => {
      const bridge = installBridge();
      const abort = new AbortController();
      routing = startNativeLinkRouting({ signal: abort.signal });
      const anchor = appendLink("https://example.com/report");
      expect(contextMenu(anchor).defaultPrevented).toBe(true);
      if (stop === "abort") {
        abort.abort();
      } else {
        routing.dispose();
      }
      await vi.dynamicImportSettled();

      expect(clickWithoutNavigation(anchor)).toBe(false);
      expect(contextMenu(anchor).defaultPrevented).toBe(false);
      expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
      expect(bridge.messages).toEqual([]);
      expect(bridge.browserRequests).toEqual([]);
    },
  );

  it("delivers each native update decline once across route changes", async () => {
    const onNativeUpdateDeclined = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawUpdate: { postMessage } } });
    routing = startNativeLinkRouting({ onNativeUpdateDeclined });

    expect(postNativeUpdate()).toBe(true);
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onNativeUpdateDeclined).toHaveBeenCalledOnce();

    expect(postNativeUpdate()).toBe(true);
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onNativeUpdateDeclined).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("does not install native behavior without the WebKit bridge", async () => {
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report");

    const event = contextMenu(anchor);

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
  });

  it("routes an unmodified external click to the native panel and preserves page-level cleanup", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting({ canPresentBrowserPanel: () => true });
    const anchor = appendLink("https://example.com/report");
    const bubbleHandler = vi.fn();
    anchor.addEventListener("click", bubbleHandler);

    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(bubbleHandler).toHaveBeenCalledOnce();
    expect(bridge.messages).toEqual([]);
    expect(bridge.browserRequests).toEqual([
      { open: true, url: "https://example.com/report", native: true },
    ]);
  });

  it("opens links externally during a Settings takeover and restores panel routing when it closes", async () => {
    const bridge = installBridge();
    let canPresentBrowserPanel = false;
    routing = startNativeLinkRouting({
      canPresentBrowserPanel: () => canPresentBrowserPanel,
    });
    const anchor = appendLink("https://example.com/report");

    expect(click(anchor).defaultPrevented).toBe(true);
    expect(bridge.messages).toEqual([
      { type: "open-link", url: "https://example.com/report", target: "external" },
    ]);
    expect(bridge.browserRequests).toEqual([]);

    canPresentBrowserPanel = true;
    expect(click(anchor).defaultPrevented).toBe(true);
    expect(bridge.messages).toHaveLength(1);
    expect(bridge.browserRequests).toEqual([
      { open: true, url: "https://example.com/report", native: true },
    ]);
  });

  it("preserves link handlers that cancel an external click", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/handled");
    anchor.addEventListener("click", (event) => event.preventDefault());

    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.messages).toEqual([]);
  });

  it("defines the hovercard once across duplicate bootstrap module instances", async () => {
    // Regression: the non-isolated jsdom lane evaluates the registration
    // module once per sibling file against one persistent document, so stale
    // bootstrap listeners fire alongside this file's own. Reproduce that order
    // and require a single registry definition.
    vi.resetModules();
    await import("../components/github-link-hovercard-registration.ts");
    const define = vi.spyOn(customElements, "define");
    const provider = document.createElement(
      "openclaw-github-link-hovercard-provider",
    ) as GitHubLinkHovercardProvider;
    provider.client = {
      request: vi.fn().mockResolvedValue({
        comments: 1,
        createdAt: "2026-07-09T10:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 102691,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        title: "Open links in a sidebar browser",
        updatedAt: "2026-07-09T10:00:00Z",
      }),
    } as unknown as GatewayBrowserClient;
    const anchor = document.createElement("a");
    anchor.href = "https://github.com/openclaw/openclaw/issues/102691";
    anchor.textContent = "#102691";
    provider.append(anchor);
    document.body.append(provider);
    anchor.focus();
    await vi.waitFor(() => expect(document.querySelector(".github-link-hovercard")).not.toBeNull());
    const hovercardDefines = define.mock.calls.filter(
      ([tag]) => tag === "openclaw-github-link-hovercard-provider",
    );
    expect(hovercardDefines).toHaveLength(1);
    define.mockRestore();
  });

  it("closes an active GitHub hovercard after routing its link", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const provider = document.createElement(
      "openclaw-github-link-hovercard-provider",
    ) as GitHubLinkHovercardProvider;
    provider.client = {
      request: vi.fn().mockResolvedValue({
        comments: 1,
        createdAt: "2026-07-09T10:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 102691,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        title: "Open links in a sidebar browser",
        updatedAt: "2026-07-09T10:00:00Z",
      }),
    } as unknown as GatewayBrowserClient;
    const anchor = document.createElement("a");
    anchor.href = "https://github.com/openclaw/openclaw/issues/102691";
    anchor.textContent = "#102691";
    provider.append(anchor);
    document.body.append(provider);
    anchor.focus();
    await vi.waitFor(() => expect(document.querySelector(".github-link-hovercard")).not.toBeNull());

    click(anchor);

    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
    expect(bridge.messages).toEqual([]);
    expect(bridge.browserRequests).toEqual([
      {
        open: true,
        url: "https://github.com/openclaw/openclaw/issues/102691",
        native: true,
      },
    ]);
  });

  it("preserves modified, local, file, download, and untrusted app-link clicks", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const links = [
      appendLink(`${location.origin}/usage`),
      appendLink("https://example.com/file", { "data-file-path": "README.md" }),
      appendLink("https://example.com/archive.zip", { download: "archive.zip" }),
      appendLink("mailto:hello@example.com"),
    ];
    for (const anchor of links) {
      expect(clickWithoutNavigation(anchor)).toBe(false);
    }
    const modified = appendLink("https://example.com/modified");
    expect(clickWithoutNavigation(modified, { metaKey: true })).toBe(false);

    expect(bridge.messages).toEqual([]);
  });

  it("offers inline, external, and copy actions for an external link", async () => {
    const bridge = installBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report?q=1");

    expect(contextMenu(anchor).defaultPrevented).toBe(true);
    await waitForMenu();
    const firstMenu = document.querySelector("openclaw-native-link-menu");
    await (firstMenu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(
      [...firstMenu!.querySelectorAll('[role="menuitem"]')].map((item) =>
        item.querySelector(".session-menu__text")?.textContent?.trim(),
      ),
    ).toEqual(["Open in Browser Panel", "Open in Default Browser", "Copy Link"]);
    menuItem("Open in Default Browser").click();
    expect(bridge.messages.at(-1)).toEqual({
      type: "open-link",
      url: "https://example.com/report?q=1",
      target: "external",
    });

    contextMenu(anchor);
    await waitForMenu();
    const panelMenu = document.querySelector("openclaw-native-link-menu");
    await (panelMenu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    menuItem("Open in Browser Panel").click();
    expect(bridge.browserRequests).toEqual([
      { open: true, url: "https://example.com/report?q=1", native: true },
    ]);
    expect(bridge.messages).toHaveLength(1);

    contextMenu(anchor);
    await waitForMenu();
    const secondMenu = document.querySelector("openclaw-native-link-menu");
    await (secondMenu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    menuItem("Copy Link").click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.com/report?q=1"),
    );
  });

  it("opens the panel menu action externally during Settings takeover and restores it afterward", async () => {
    const bridge = installBridge();
    let canPresentBrowserPanel = false;
    routing = startNativeLinkRouting({
      canPresentBrowserPanel: () => canPresentBrowserPanel,
    });
    const anchor = appendLink("https://example.com/report");

    for (const available of [false, true]) {
      canPresentBrowserPanel = available;
      contextMenu(anchor);
      await waitForMenu();
      const menu = document.querySelector("openclaw-native-link-menu");
      await (menu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      menuItem("Open in Browser Panel").click();
      expect(bridge.messages).toEqual([
        { type: "open-link", url: "https://example.com/report", target: "external" },
      ]);
      expect(bridge.browserRequests).toEqual(
        available ? [{ open: true, url: "https://example.com/report", native: true }] : [],
      );
    }
  });

  it("ignores a stale hide event after replacing the context menu", async () => {
    installBridge();
    routing = startNativeLinkRouting();
    const firstAnchor = appendLink("https://example.com/first");
    const secondAnchor = appendLink("https://example.com/second");

    contextMenu(firstAnchor);
    await waitForMenu();
    const firstMenu = document.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-native-link-menu",
    );
    expect(firstMenu).not.toBeNull();
    await firstMenu?.updateComplete;
    const firstDropdown = firstMenu?.querySelector("wa-dropdown");
    expect(firstDropdown).not.toBeNull();

    contextMenu(secondAnchor);
    await waitForMenu();
    const secondMenu = document.querySelector("openclaw-native-link-menu");
    expect(secondMenu).not.toBe(firstMenu);

    firstDropdown?.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true }),
    );

    expect(document.querySelector("openclaw-native-link-menu")).toBe(secondMenu);
  });

  it("mounts a fallback menu inside an active dialog", async () => {
    installBridge();
    routing = startNativeLinkRouting();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/dialog-link";
    dialog.append(anchor);
    document.body.append(dialog);

    contextMenu(anchor);
    await waitForMenu();

    const menu = dialog.querySelector("openclaw-native-link-menu");
    expect(menu).not.toBeNull();
    await (menu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(menuItem("Open in Browser Panel")).not.toBeNull();
  });

  it("keeps modal menus in the styled light-DOM slot", async () => {
    installBridge();
    routing = startNativeLinkRouting();
    const modal = document.createElement("openclaw-modal-dialog");
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/modal-link";
    modal.append(anchor);
    document.body.append(modal);
    await (modal as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;

    contextMenu(anchor);
    await waitForMenu();

    const menu = modal.querySelector("openclaw-native-link-menu");
    expect(menu).not.toBeNull();
    expect(menu?.getRootNode()).toBe(document);
    await (menu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(menuItem("Open in Browser Panel")).not.toBeNull();
  });

  it("removes listeners and an open menu on dispose", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report");
    contextMenu(anchor);
    await waitForMenu();
    expect(document.querySelector("openclaw-native-link-menu")).not.toBeNull();

    routing.dispose();
    routing = undefined;

    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
    expect(clickWithoutNavigation(anchor)).toBe(false);
    expect(contextMenu(anchor).defaultPrevented).toBe(false);
    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
    expect(bridge.messages).toEqual([]);
  });
});
