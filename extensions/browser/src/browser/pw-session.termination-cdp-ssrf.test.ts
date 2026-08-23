// Browser tests cover pw session termination CDP SSRF guard plugin behavior.
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";

const {
  closePlaywrightBrowserConnection,
  forceDisconnectPlaywrightForTarget,
  listPagesViaPlaywright,
} = pwAi;

const wsMockState = vi.hoisted(() => ({
  constructorUrls: [] as string[],
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;

    readyState = 0;
    private readonly handlers = new Map<string, (error?: Error) => void>();

    constructor(url: string) {
      wsMockState.constructorUrls.push(url);
      setTimeout(() => {
        this.handlers.get("error")?.(new Error("test socket should not open"));
      }, 0);
    }

    on(event: string, handler: (error?: Error) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      this.readyState = 3;
      this.handlers.get("close")?.();
    }

    send() {}
  }

  return { default: MockWebSocket };
});

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function installBrowserMock() {
  const sessionSend = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    return {};
  });
  const sessionDetach = vi.fn(async () => {});
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => "target"),
    url: vi.fn(() => "https://example.com"),
  } as unknown as import("playwright-core").Page;
  const context = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    })),
  } as unknown as import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return { browserClose };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  wsMockState.constructorUrls = [];
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session termination CDP SSRF guard", () => {
  it("blocks discovered target WebSocket URLs before best-effort termination opens a socket", async () => {
    const { browserClose } = installBrowserMock();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "TARGET_1",
            webSocketDebuggerUrl: "ws://169.254.169.254/devtools/page/TARGET_1",
          },
        ]),
        { status: 200 },
      ),
    );

    try {
      await listPagesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      await forceDisconnectPlaywrightForTarget({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:18792/json/list");
      expect(wsMockState.constructorUrls).toEqual([]);
      expect(browserClose).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
