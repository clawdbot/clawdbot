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
  constructorOptions: [] as Array<{ agent?: unknown } | undefined>,
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;

    readyState = 0;
    private readonly handlers = new Map<string, (error?: Error) => void>();

    constructor(url: string, options?: { agent?: unknown }) {
      wsMockState.constructorUrls.push(url);
      wsMockState.constructorOptions.push(options);
      setTimeout(() => {
        this.handlers.get("error")?.(new Error("test socket should not open"));
      }, 0);
    }

    on(event: string, handler: (error?: Error) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.handlers.get("close")?.();
    }

    send() {}
  }

  return { default: MockWebSocket };
});

vi.mock(
  "./pw-session-cdp-transport.js",
  () => import("./pw-session-cdp-transport.test-support.js"),
);

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");

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
  getChromeWebSocketEndpointSpy.mockResolvedValue({
    url: "ws://127.0.0.1:18792/devtools/browser/ROOT",
  });
  return { browserClose };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  wsMockState.constructorUrls = [];
  wsMockState.constructorOptions = [];
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

      const fetchUrls = fetchSpy.mock.calls.map((call) => call[0]);
      expect(fetchUrls).toContain("http://127.0.0.1:18792/json/list");
      expect(fetchUrls).not.toContain("http://169.254.169.254/json/list");
      expect(wsMockState.constructorUrls).toEqual([]);
      expect(browserClose).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the discovered target lookup pin for best-effort termination sockets", async () => {
    installBrowserMock();
    const lookup = vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : callback;
      if (typeof cb === "function") {
        cb(null, "127.0.0.1", 4);
      }
    });
    const assertAllowedSpy = vi
      .spyOn(await import("./cdp.helpers.js"), "assertCdpEndpointAllowed")
      .mockImplementation(async (url: string) =>
        url.includes("/devtools/page/")
          ? {
              hostname: "cdp-pinned.test",
              addresses: ["127.0.0.1"],
              lookup: lookup as never,
            }
          : undefined,
      );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "TARGET_1",
            webSocketDebuggerUrl: "ws://cdp-pinned.test/devtools/page/TARGET_1",
          },
        ]),
        { status: 200 },
      ),
    );

    try {
      await listPagesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ssrfPolicy: {},
      });

      await forceDisconnectPlaywrightForTarget({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
        ssrfPolicy: {},
      });

      expect(wsMockState.constructorUrls).toEqual(["ws://cdp-pinned.test/devtools/page/TARGET_1"]);
      expect(wsMockState.constructorOptions[0]?.agent).toBeDefined();
    } finally {
      assertAllowedSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
