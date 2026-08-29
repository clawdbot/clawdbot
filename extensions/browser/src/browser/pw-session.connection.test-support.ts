import { chromium } from "playwright-core";
import { afterEach, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";
import { markPageRefBlocked, markTargetBlocked } from "./pw-session-connection.js";

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

export type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
};

export function makeEmptyBrowser(): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const context = {
    pages: () => [],
    on: vi.fn(),
    newCDPSession: vi.fn(),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose };
}

export function setupPwSessionConnectionTest() {
  const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
  const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");
  const getChromeWebSocketUrlSpy = getChromeWebSocketEndpointSpy;

  const { closePlaywrightBrowserConnection } = pwAi;

  afterEach(async () => {
    connectOverCdpSpy.mockReset();
    getChromeWebSocketUrlSpy.mockReset();
    registerManagedProxyBrowserCdpBypassMock.mockReset();
    registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
    await closePlaywrightBrowserConnection().catch(() => {});
    vi.useRealTimers();
  });

  return {
    connectOverCdpSpy,
    getChromeWebSocketEndpointSpy,
    getChromeWebSocketUrlSpy,
    markPageRefBlocked,
    markTargetBlocked,
    pwAi,
    registerManagedProxyBrowserCdpBypassMock,
  };
}
