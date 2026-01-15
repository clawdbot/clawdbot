import { describe, expect, it, vi } from "vitest";

describe("pw-session getPageForTargetId", () => {
  it("falls back to the only page when CDP session attachment is blocked (extension relays)", async () => {
    vi.resetModules();

    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;

    const page = {
      on: pageOn,
      context: () => context,
    } as unknown as import("playwright-core").Page;

    // Fill pages() after page exists.
    (context as unknown as { pages: () => unknown[] }).pages = () => [page];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    vi.doMock("playwright-core", () => ({
      chromium: {
        connectOverCDP: vi.fn(async () => browser),
      },
    }));

    vi.doMock("./chrome.js", () => ({
      getChromeWebSocketUrl: vi.fn(async () => null),
    }));

    const mod = await import("./pw-session.js");
    const resolved = await mod.getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "NOT_A_TAB",
    });
    expect(resolved).toBe(page);

    await mod.closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });
});
