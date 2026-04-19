import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

afterEach(async () => {
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

function createExtensionFallbackBrowserHarness(options?: {
  urls?: string[];
  newCDPSessionError?: string;
}) {
  const pageOn = vi.fn();
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => {
    throw new Error(options?.newCDPSessionError ?? "Not allowed");
  });

  const context = {
    pages: () => [],
    on: contextOn,
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;

  const pages = (options?.urls ?? [undefined]).map(
    (url) =>
      Object.assign(
        { on: pageOn, context: () => context },
        url ? { url: () => url } : {},
      ) as unknown as import("playwright-core").Page,
  );
  (context as unknown as { pages: () => unknown[] }).pages = () => pages;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return { browserClose, newCDPSession, pages };
}

describe("pw-session getPageForTargetId", () => {
  it("falls back to the only page when Playwright cannot resolve target ids", async () => {
    const { browserClose, pages } = createExtensionFallbackBrowserHarness();
    const [page] = pages;

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "NOT_A_TAB",
    });
    expect(resolved).toBe(page);

    await closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });

  it("uses the shared HTTP-base normalization when falling back to /json/list for direct WebSocket CDP URLs", async () => {
    const [, pageB] = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
    }).pages;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "ws://127.0.0.1:18792/devtools/browser/SESSION?token=abc",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:18792/json/list?token=abc",
        expect.any(Object),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves pages from /json/list when page CDP probing fails", async () => {
    const { newCDPSession, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
      newCDPSessionError: "Target.attachToBrowserTarget: Not allowed",
    });
    const [, pageB] = pages;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19993",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(newCDPSession).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
