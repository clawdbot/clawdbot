// Browser tests cover tabs.attach only plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../test-support.js";
import "../server-context.chrome-test-harness.js";
import "../../test-support/browser-security.mock.js";
import * as chromeModule from "../chrome.js";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function makeLoopbackProfile(attachOnly: boolean) {
  return makeBrowserProfile({
    name: "manual-cdp",
    cdpUrl: "http://127.0.0.1:9222",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 9222,
    color: "#00AA00",
    attachOnly,
  });
}

describe("browser tab routes attachOnly loopback profiles", () => {
  it("lists tabs for manual loopback CDP profiles under strict SSRF", async () => {
    const state = makeBrowserServerState({
      profile: makeLoopbackProfile(true),
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });

    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    isChromeCdpReady.mockResolvedValue(true);

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("http://127.0.0.1:9222/json/list");
      return new Response(
        JSON.stringify([
          {
            id: "PAGE-1",
            title: "WordPress",
            url: "https://example.com/wp-login.php",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
            type: "page",
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
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

  it.each([
    { attachOnly: false, allowPrivateNetwork: false, expectedUrl: "" },
    {
      attachOnly: false,
      allowPrivateNetwork: true,
      expectedUrl: "http://93.184.216.34/proxy-routed",
    },
    {
      attachOnly: true,
      allowPrivateNetwork: false,
      expectedUrl: "http://93.184.216.34/proxy-routed",
    },
  ])(
    "applies managed browser proxy policy to tab list URLs (attachOnly=$attachOnly, allowPrivateNetwork=$allowPrivateNetwork)",
    async ({ attachOnly, allowPrivateNetwork, expectedUrl }) => {
      const state = makeBrowserServerState({
        profile: makeLoopbackProfile(attachOnly),
        resolvedOverrides: {
          defaultProfile: "manual-cdp",
          extraArgs: ["--proxy-server=http://proxy.example.test:8080"],
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: allowPrivateNetwork },
        },
      });

      const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
      isChromeCdpReady.mockResolvedValue(true);

      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: "PAGE-1",
                title: "Proxy routed",
                url: "http://93.184.216.34/proxy-routed",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
                type: "page",
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const { app, getHandlers, postHandlers } = createBrowserRouteApp();
      registerBrowserTabRoutes(app, ctx as never);
      const getTabs = getHandlers.get("/tabs");
      const postTabsAction = postHandlers.get("/tabs/action");
      expect(getTabs).toBeTypeOf("function");
      expect(postTabsAction).toBeTypeOf("function");

      const getResponse = createBrowserRouteResponse();
      await getTabs?.({ params: {}, query: { profile: "manual-cdp" }, body: {} }, getResponse.res);

      const actionResponse = createBrowserRouteResponse();
      await postTabsAction?.(
        { params: {}, query: { profile: "manual-cdp" }, body: { action: "list" } },
        actionResponse.res,
      );

      expect(getResponse.statusCode).toBe(200);
      expect(actionResponse.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const response of [getResponse, actionResponse]) {
        expect(response.body).toMatchObject({
          tabs: [{ targetId: "PAGE-1", title: "Proxy routed", url: expectedUrl }],
        });
      }
    },
  );
});
