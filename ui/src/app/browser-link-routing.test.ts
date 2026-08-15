/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBrowserLinkPreference } from "../components/browser/browser-link-preference.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import "../components/browser/browser-panel.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

let nativeRouting: ReturnType<typeof startNativeLinkRouting> | undefined;
let stopBrowserLinkRouting: (() => void) | undefined;
let stopCollectingBrowserRequests: (() => void) | undefined;

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

function mouseEvent(type: "click" | "auxclick", init: MouseEventInit = {}) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: type === "auxclick" ? 1 : 0,
    ...init,
  });
}

function startBrowserLinkRouting(methods: string[] = ["browser.request"]) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.available = methods.includes("browser.request");
  document.body.append(panel);
  stopBrowserLinkRouting = () => panel.remove();
}

function collectBrowserRequests(urls: string[]) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ url?: string }>).detail;
    urls.push(detail.url ?? "");
  };
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  stopCollectingBrowserRequests = () =>
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  document.body.replaceChildren();
  writeBrowserLinkPreference(false);
});

afterEach(() => {
  nativeRouting?.dispose();
  nativeRouting = undefined;
  stopBrowserLinkRouting?.();
  stopBrowserLinkRouting = undefined;
  stopCollectingBrowserRequests?.();
  stopCollectingBrowserRequests = undefined;
  document.body.replaceChildren();
  writeBrowserLinkPreference(false);
  Reflect.deleteProperty(window, "webkit");
  vi.unstubAllGlobals();
});

describe("Control UI browser link routing", () => {
  it("preserves existing browser behavior by default", () => {
    startBrowserLinkRouting();
    const event = mouseEvent("click");

    appendLink("https://example.com/report").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("routes primary, modified, middle, and new-window links to new browser-panel tabs", () => {
    writeBrowserLinkPreference(true);
    const urls: string[] = [];
    collectBrowserRequests(urls);
    startBrowserLinkRouting();

    const cases: Array<[HTMLAnchorElement, MouseEvent]> = [
      [appendLink("https://example.com/primary"), mouseEvent("click")],
      [appendLink("https://example.com/meta"), mouseEvent("click", { metaKey: true })],
      [appendLink("https://example.com/control"), mouseEvent("click", { ctrlKey: true })],
      [appendLink("https://example.com/middle"), mouseEvent("auxclick")],
      [appendLink("https://example.com/new-window", { target: "_blank" }), mouseEvent("click")],
    ];

    for (const [anchor, event] of cases) {
      anchor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(urls).toEqual([
      "https://example.com/primary",
      "https://example.com/meta",
      "https://example.com/control",
      "https://example.com/middle",
      "https://example.com/new-window",
    ]);
  });

  it("preserves link handlers that cancel navigation", () => {
    writeBrowserLinkPreference(true);
    const urls: string[] = [];
    collectBrowserRequests(urls);
    startBrowserLinkRouting();
    const anchor = appendLink("https://example.com/handled");
    anchor.addEventListener("click", (event) => event.preventDefault());
    const event = mouseEvent("click");

    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(urls).toEqual([]);
  });

  it("preserves host behavior when the browser panel is unavailable", () => {
    writeBrowserLinkPreference(true);
    startBrowserLinkRouting([]);
    const event = mouseEvent("click");

    appendLink("https://example.com/report").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through to existing app routing when the Control UI panel is unavailable", () => {
    writeBrowserLinkPreference(true);
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawLink: { postMessage } } },
    });
    startBrowserLinkRouting([]);
    nativeRouting = startNativeLinkRouting();
    const event = mouseEvent("click");

    appendLink("https://example.com/report").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "open-link",
      url: "https://example.com/report",
      target: "inline",
    });
  });

  it("ignores local, download, file, non-web, alt-click, and right-click targets", () => {
    writeBrowserLinkPreference(true);
    const urls: string[] = [];
    collectBrowserRequests(urls);
    startBrowserLinkRouting();
    const cases: Array<[HTMLAnchorElement, MouseEvent]> = [
      [appendLink(`${location.origin}/usage`), mouseEvent("click")],
      [
        appendLink("https://example.com/archive.zip", { download: "archive.zip" }),
        mouseEvent("click"),
      ],
      [
        appendLink("https://example.com/file", { "data-file-path": "README.md" }),
        mouseEvent("click"),
      ],
      [appendLink("mailto:hello@example.com"), mouseEvent("click")],
      [appendLink("tel:+15555550123"), mouseEvent("click")],
      [appendLink("https://example.com/alt"), mouseEvent("click", { altKey: true })],
      [appendLink("https://example.com/context"), mouseEvent("auxclick", { button: 2 })],
    ];

    for (const [anchor, event] of cases) {
      anchor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(urls).toEqual([]);
  });
});
