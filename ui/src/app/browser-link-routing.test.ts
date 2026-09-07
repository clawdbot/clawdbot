/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

let nativeRouting: ReturnType<typeof startNativeLinkRouting> | undefined;
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

function startBrowserLinkRouting(available = true) {
  nativeRouting = startNativeLinkRouting({
    shouldOpenInControlUiBrowser: () => available,
  });
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
  document.body.replaceChildren();
});

afterEach(() => {
  nativeRouting?.dispose();
  nativeRouting = undefined;
  stopCollectingBrowserRequests?.();
  stopCollectingBrowserRequests = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "webkit");
  vi.unstubAllGlobals();
});

describe("Control UI browser link routing", () => {
  it("preserves existing browser behavior by default", async () => {
    startBrowserLinkRouting(false);
    const event = mouseEvent("click");

    appendLink("https://example.com/report").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("routes primary, modified, middle, and new-window links to new browser-panel tabs", async () => {
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

  it("preserves link handlers that cancel navigation", async () => {
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

  it.each([false, true])(
    "native links take precedence when the remote preference is %s",
    async (enabled) => {
      const postMessage = vi.fn();
      Object.defineProperty(window, "webkit", {
        configurable: true,
        value: {
          messageHandlers: {
            openclawLink: { postMessage },
            openclawBrowser: { postMessage: vi.fn() },
          },
        },
      });
      const requests: unknown[] = [];
      const listener = (event: Event) => requests.push((event as CustomEvent).detail);
      window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
      stopCollectingBrowserRequests = () =>
        window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
      startBrowserLinkRouting(enabled);
      const event = mouseEvent("click");

      appendLink("https://example.com/report").dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(postMessage).not.toHaveBeenCalled();
      expect(requests).toEqual([
        {
          open: true,
          url: "https://example.com/report",
          native: true,
        },
      ]);
    },
  );

  it("ignores local, download, file, non-web, Shift/Alt, and right-click targets", async () => {
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
      [appendLink("https://example.com/shift"), mouseEvent("click", { shiftKey: true })],
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
