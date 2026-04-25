import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../test-support.js";
import "../server-context.chrome-test-harness.js";
import * as chromeModule from "../chrome.js";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser tab routes attachOnly loopback profiles", () => {
  it("lists tabs for manual loopback CDP profiles under strict SSRF", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });

    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    isChromeCdpReady.mockResolvedValue(true);

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("http://127.0.0.1:9222/json/list");
      return {
        ok: true,
        json: async () => [
          {
            id: "PAGE-1",
            title: "WordPress",
            url: "https://example.com/wp-login.php",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, ctx as never);
    const handler = getHandlers.get("/tabs");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "manual-cdp" }, body: {} }, response.res);

    expect(isChromeCdpReady).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      tabs: [
        {
          targetId: "PAGE-1",
          suggestedTargetId: "t1",
          tabId: "t1",
          title: "WordPress",
          url: "https://example.com/wp-login.php",
          wsUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
          type: "page",
        },
      ],
    });
  });
});
