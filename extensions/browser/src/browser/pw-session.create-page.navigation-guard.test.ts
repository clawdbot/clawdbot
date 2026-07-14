// Browser tests cover pw session.create page.navigation guard plugin behavior.
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import "../test-support/browser-security.mock.js";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { pwAi } from "./pw-ai.js";
import {
  gotoPageWithNavigationGuard,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";

const {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  listPagesViaPlaywright,
} = pwAi;

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

type MockRoute = {
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
  fulfill: (response: { status: number; body: string }) => Promise<void>;
  abort: () => Promise<void>;
};
type MockRequest = {
  isNavigationRequest: () => boolean;
  frame: () => object;
  resourceType?: () => string;
  url: () => string;
};
type MockRouteHandler = (route: MockRoute, request: MockRequest) => Promise<void>;

function installBrowserMocks() {
  const pageOn = vi.fn();
  let routeHandler: MockRouteHandler | null = null;
  const pageGoto = vi.fn<
    (...args: unknown[]) => Promise<null | { request: () => Record<string, unknown> }>
  >(async () => null);
  const pageTitle = vi.fn(async () => "");
  const pageUrl = vi.fn(() => "about:blank");
  const pageRoute = vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
    routeHandler = handler;
  });
  const pageUnroute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
    if (routeHandler === handler) {
      routeHandler = null;
    }
  });
  const openPages: import("playwright-core").Page[] = [];
  const pageClose = vi.fn(async () => {
    const index = openPages.indexOf(page);
    if (index >= 0) {
      openPages.splice(index, 1);
    }
  });
  const mainFrame = {};
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const sessionSend = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    return {};
  });
  const sessionDetach = vi.fn(async () => {});

  const context = {
    pages: () => openPages,
    on: contextOn,
    newPage: vi.fn(async () => {
      openPages.push(page);
      return page;
    }),
    newCDPSession: vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const page = {
    on: pageOn,
    context: () => context,
    goto: pageGoto,
    title: pageTitle,
    url: pageUrl,
    route: pageRoute,
    unroute: pageUnroute,
    close: pageClose,
    mainFrame: () => mainFrame,
  } as unknown as import("playwright-core").Page;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);

  const getBrowserDisconnectedHandler = () =>
    browserOn.mock.calls.find((call) => call[0] === "disconnected")?.[1] as
      | (() => void)
      | undefined;

  return {
    pageGoto,
    page,
    pageRoute,
    pageUnroute,
    pageUrl,
    browserClose,
    pageClose,
    sessionSend,
    getBrowserDisconnectedHandler,
    getRouteHandler: () => routeHandler,
    mainFrame,
    pushOpenPage: () => {
      openPages.push(page);
      return page;
    },
  };
}

function createMockRoute(route?: Partial<MockRoute>): MockRoute {
  return {
    continue: vi.fn(async () => {}),
    fallback: vi.fn(async () => {}),
    fulfill: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...route,
  };
}

async function dispatchMockNavigation(params: {
  getRouteHandler: () => MockRouteHandler | null;
  mainFrame: object;
  url: string;
  frame?: object;
  frameError?: Error;
  isNavigationRequest?: boolean;
  resourceType?: string;
  route?: Partial<MockRoute>;
}) {
  const handler = params.getRouteHandler();
  if (!handler) {
    throw new Error("missing route handler");
  }
  const { resourceType } = params;
  await handler(createMockRoute(params.route), {
    isNavigationRequest: () => params.isNavigationRequest ?? true,
    frame: () => {
      if (params.frameError) {
        throw params.frameError;
      }
      return params.frame ?? params.mainFrame;
    },
    ...(resourceType ? { resourceType: () => resourceType } : {}),
    url: () => params.url,
  });
}

function mockBlockedRedirectNavigation(params: {
  pageGoto: ReturnType<typeof installBrowserMocks>["pageGoto"];
  getRouteHandler: () => MockRouteHandler | null;
  mainFrame: object;
  startUrl?: string;
  hopUrl?: string;
  hopIsNavigationRequest?: boolean;
  hopResourceType?: string;
}) {
  params.pageGoto.mockImplementationOnce(async () => {
    await dispatchMockNavigation({
      getRouteHandler: params.getRouteHandler,
      mainFrame: params.mainFrame,
      url: params.startUrl ?? "https://93.184.216.34/start",
    });
    await dispatchMockNavigation({
      getRouteHandler: params.getRouteHandler,
      mainFrame: params.mainFrame,
      url: params.hopUrl ?? "http://127.0.0.1:18080/internal-hop",
      isNavigationRequest: params.hopIsNavigationRequest,
      resourceType: params.hopResourceType,
    });
    throw new Error("Navigation aborted");
  });
}

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session createPageViaPlaywright navigation guard", () => {
  it("blocks unsupported non-network URLs", async () => {
    const { pageGoto } = installBrowserMocks();

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("allows about:blank without network navigation", async () => {
    const { pageGoto } = installBrowserMocks();

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("blocks hostname navigation when strict SSRF policy is configured", async () => {
    const { pageGoto } = installBrowserMocks();

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("blocks private intermediate redirect hops", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("blocks private redirect hops even when Playwright marks hop as non-navigation", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({
      pageGoto,
      getRouteHandler,
      mainFrame,
      hopIsNavigationRequest: false,
      hopResourceType: "document",
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("fails closed as a top-level navigation when request frame resolution throws", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        frameError: new Error("frame detached"),
        url: "http://127.0.0.1:18080/internal-hop",
      });
      throw new Error("Navigation aborted");
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("aborts private subframe document hops without quarantining the page", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const subframe = {};
    const subframeRoute = createMockRoute();
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://93.184.216.34/start",
      });
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        frame: subframe,
        url: "http://127.0.0.1:18080/internal-hop",
        route: subframeRoute,
      });
      return {
        request: () => ({
          url: () => "https://93.184.216.34/start",
          redirectedFrom: () => null,
        }),
      };
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://93.184.216.34/start",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(subframeRoute.abort).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("preserves the created tab on ordinary navigation failure", async () => {
    const { pageGoto, pageClose } = installBrowserMocks();
    pageGoto.mockRejectedValueOnce(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"));

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://93.184.216.34/start",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(created.url).toBe("about:blank");
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("does not quarantine a tab when route.continue fails", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://example.com",
        route: {
          continue: vi.fn(async () => {
            throw new Error("page.goto: Frame has been detached");
          }),
        },
      });
      throw new Error("page.goto: Frame has been detached");
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("ignores already-handled route races during guarded navigation", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const route = createMockRoute({
      continue: vi.fn(async () => {
        throw new Error("Route is already handled");
      }),
    });
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://example.com",
        route,
      });
      return null;
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("propagates unsupported redirect protocols as navigation errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({
      pageGoto,
      getRouteHandler,
      mainFrame,
      hopUrl: "file:///etc/passwd",
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("does not quarantine a tab on transient redirect lookup errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const assertNavigationAllowedSpy = vi.spyOn(
      navigationGuardModule,
      "assertBrowserNavigationAllowed",
    );
    assertNavigationAllowedSpy.mockImplementation(async (opts: { url: string }) => {
      if (opts.url === "http://127.0.0.1:18080/internal-hop") {
        throw new Error("getaddrinfo EAI_AGAIN internal-hop");
      }
    });
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    try {
      const created = await createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      });
      const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });

      expect(created.targetId).toBe("TARGET_1");
      expect(pages).toHaveLength(1);
      expect(pageClose).not.toHaveBeenCalled();
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }
  });

  it("does not quarantine a tab on transient post-navigation check errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const assertRedirectChainAllowedSpy = vi.spyOn(
      navigationGuardModule,
      "assertBrowserNavigationRedirectChainAllowed",
    );
    assertRedirectChainAllowedSpy.mockRejectedValueOnce(
      new Error("getaddrinfo EAI_AGAIN postcheck.example"),
    );
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://93.184.216.34/start",
      });
      return {
        request: () => ({
          url: () => "https://93.184.216.34/final",
          redirectedFrom: () => ({
            url: () => "https://postcheck.example/hop",
            redirectedFrom: () => null,
          }),
        }),
      };
    });

    try {
      await expect(
        createPageViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          url: "https://93.184.216.34/start",
        }),
      ).rejects.toThrow(/getaddrinfo .*postcheck\.example/);

      const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });
      expect(pages).toHaveLength(1);
      expect(pages[0]?.targetId).toBe("TARGET_1");
      expect(pageClose).not.toHaveBeenCalled();
    } finally {
      assertRedirectChainAllowedSpy.mockRestore();
    }
  });

  it("keeps blocked tab quarantined if close fails", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });
    expect(pages).toHaveLength(0);
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("preserves blocked-target quarantine across forced reconnects", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:18792",
      reason: "test forced reconnect",
    });

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
  });

  it("preserves blocked-target quarantine across transport disconnects", async () => {
    const { pageGoto, pageClose, getBrowserDisconnectedHandler, getRouteHandler, mainFrame } =
      installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    const disconnectedHandler = getBrowserDisconnectedHandler();
    expect(disconnectedHandler).toBeTypeOf("function");
    disconnectedHandler?.();

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
  });

  it("keeps blocked tabs inaccessible when target lookup fails", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
  });

  it("does not fall back to another tab when explicit target lookup misses", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    sessionSend.mockImplementationOnce(async (method: string) => {
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "TARGET_2" } };
      }
      return {};
    });
    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    let targetInfoLookups = 0;
    sessionSend.mockImplementation(async (method: string) => {
      if (method === "Target.getTargetInfo") {
        targetInfoLookups += 1;
        return {
          targetInfo: { targetId: targetInfoLookups % 2 === 1 ? "TARGET_1" : "TARGET_2" },
        };
      }
      return {};
    });

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "MISSING_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
  });

  it("quarantines the actual page when blocked navigation receives a stale target id", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));

    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });

    const page = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
    });

    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "http://127.0.0.1:18080/internal-hop",
      });
      throw new Error("Navigation aborted");
    });

    // Simulate target-info churn while quarantining so caller target id cannot be trusted.
    sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));

    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        url: "https://93.184.216.34/start",
        timeoutMs: 1000,
        targetId: "MISSING_TARGET",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
  });

  it("falls back to caller targetId quarantine when target lookup fails", async () => {
    const first = installBrowserMocks();
    first.pageClose.mockRejectedValueOnce(new Error("close failed"));

    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });
    const page = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_1",
    });

    first.pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler: first.getRouteHandler,
        mainFrame: first.mainFrame,
        url: "http://127.0.0.1:18080/internal-hop",
      });
      throw new Error("Navigation aborted");
    });

    first.sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));
    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        url: "https://93.184.216.34/start",
        timeoutMs: 1000,
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:18792",
      reason: "test reconnect after blocked navigation",
    });

    const second = installBrowserMocks();
    second.pushOpenPage();

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("Browser target is unavailable after SSRF policy blocked its navigation.");
  });
});

describe("pw-session selected-page interaction request guard", () => {
  const strictPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

  it("preserves policy-free callers without installing a route", async () => {
    const { page, pageRoute, pageUnroute } = installBrowserMocks();

    await expect(withPageNavigationRequestGuard({ page, action: async () => "ok" })).resolves.toBe(
      "ok",
    );

    expect(pageRoute).not.toHaveBeenCalled();
    expect(pageUnroute).not.toHaveBeenCalled();
  });

  it("fails closed before request handling when strict policy uses an explicit browser proxy", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const documentRoute = createMockRoute();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        browserProxyMode: "explicit-browser-proxy",
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/public",
            route: documentRoute,
          });
          return "unsafe";
        },
      }),
    ).rejects.toThrow("strict browser SSRF policy cannot be enforced");

    expect(documentRoute.fallback).not.toHaveBeenCalled();
    expect(documentRoute.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
  });

  it("revalidates the current URL after route setup before starting the action", async () => {
    const { page, pageRoute, pageUnroute, pageUrl } = installBrowserMocks();
    const installRoute = pageRoute.getMockImplementation();
    pageRoute.mockImplementationOnce(async (...args) => {
      await installRoute?.(...args);
      pageUrl.mockReturnValue("http://127.0.0.1:18080/private-before-action");
    });
    const action = vi.fn(async () => "unsafe");

    await expect(
      withPageNavigationRequestGuard({ page, ssrfPolicy: strictPolicy, action }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(action).not.toHaveBeenCalled();
    expect(pageUnroute).toHaveBeenCalledWith("**", pageRoute.mock.calls[0]?.[1]);
  });

  it("reports an unsafe preflight before route cleanup settles", async () => {
    const { page, pageRoute, pageUnroute, pageUrl } = installBrowserMocks();
    const installRoute = pageRoute.getMockImplementation();
    pageRoute.mockImplementationOnce(async (...args) => {
      await installRoute?.(...args);
      pageUrl.mockReturnValue("http://127.0.0.1:18080/private-before-action");
    });
    let releaseCleanup!: () => void;
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const originalUnroute = pageUnroute.getMockImplementation();
    pageUnroute.mockImplementationOnce(async (...args) => {
      await cleanupPending;
      await originalUnroute?.(...args);
    });
    const events: string[] = [];
    const action = vi.fn(async () => "unsafe");

    const guarded = withPageNavigationRequestGuard({
      page,
      ssrfPolicy: strictPolicy,
      action,
      onPolicyDenied: (event) => {
        events.push(
          event.state === "detected"
            ? event.state
            : `${event.state}:${String(event.sourcePreserved)}`,
        );
      },
    });

    await vi.waitFor(() => expect(events).toEqual(["detected", "handled:false"]));
    expect(action).not.toHaveBeenCalled();
    releaseCleanup();
    await expect(guarded).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("falls through allowed documents and subresources, then removes only its handler", async () => {
    const { getRouteHandler, mainFrame, page, pageRoute, pageUnroute } = installBrowserMocks();
    const documentRoute = createMockRoute();
    const imageRoute = createMockRoute();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/page",
            route: documentRoute,
          });
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1/ignored-subresource.png",
            isNavigationRequest: false,
            resourceType: "image",
            route: imageRoute,
          });
          return "ok";
        },
      }),
    ).resolves.toBe("ok");

    expect(documentRoute.fallback).toHaveBeenCalledTimes(1);
    expect(imageRoute.fallback).toHaveBeenCalledTimes(1);
    expect(documentRoute.continue).not.toHaveBeenCalled();
    expect(imageRoute.continue).not.toHaveBeenCalled();
    const handler = pageRoute.mock.calls[0]?.[1];
    expect(pageRoute).toHaveBeenCalledWith("**", handler);
    expect(pageUnroute).toHaveBeenCalledWith("**", handler);
  });

  it.each([
    { name: "top-level", frame: undefined },
    { name: "subframe", frame: {} },
  ])(
    "answers a denied $name document through interception and preserves the source",
    async ({ frame }) => {
      const { getRouteHandler, mainFrame, page } = installBrowserMocks();
      const route = createMockRoute();
      let caught: unknown;

      try {
        await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: strictPolicy,
          action: async () => {
            await dispatchMockNavigation({
              getRouteHandler,
              mainFrame,
              frame,
              url: "http://127.0.0.1:18080/private",
              route,
            });
            throw new Error("locator detached");
          },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SsrFBlockedError);
      expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
      expect(route.abort).not.toHaveBeenCalled();
      expect(route.fallback).not.toHaveBeenCalled();
      expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(true);
      expect(page.url()).toBe("about:blank");
    },
  );

  it("does not claim preservation when postflight also finds a policy violation", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const route = createMockRoute();
    const committedSubframeBlock = new SsrFBlockedError("blocked committed subframe");
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            frame: {},
            url: "http://127.0.0.1:18080/private",
            route,
          });
          throw committedSubframeBlock;
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SsrFBlockedError);
    expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });

  it("reports policy detection before a pending fulfillment settles", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    let releaseFulfill!: () => void;
    const fulfillPending = new Promise<void>((resolve) => {
      releaseFulfill = resolve;
    });
    const route = createMockRoute({ fulfill: vi.fn(async () => await fulfillPending) });
    const events: string[] = [];

    const guarded = withPageNavigationRequestGuard({
      page,
      ssrfPolicy: strictPolicy,
      onPolicyDenied: (event) => {
        events.push(
          event.state === "detected"
            ? event.state
            : `${event.state}:${String(event.sourcePreserved)}`,
        );
      },
      action: async () => {
        await dispatchMockNavigation({
          getRouteHandler,
          mainFrame,
          url: "http://127.0.0.1:18080/private",
          route,
        });
      },
    });

    await vi.waitFor(() => expect(route.fulfill).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["detected"]);
    releaseFulfill();
    await expect(guarded).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(events).toEqual(["detected", "handled:true"]);
  });

  it("does not report an unsafe source while another denied fulfillment is pending", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstRoute = createMockRoute({ fulfill: vi.fn(async () => await firstPending) });
    const secondRoute = createMockRoute({ fulfill: vi.fn(async () => await secondPending) });
    const events: string[] = [];

    const guarded = withPageNavigationRequestGuard({
      page,
      ssrfPolicy: strictPolicy,
      onPolicyDenied: (event) => {
        events.push(
          event.state === "detected"
            ? event.state
            : `${event.state}:${String(event.sourcePreserved)}`,
        );
      },
      action: async () => {
        await Promise.all([
          dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/first",
            route: firstRoute,
          }),
          dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            frame: {},
            url: "http://127.0.0.1:18080/second",
            route: secondRoute,
          }),
        ]);
      },
    });

    await vi.waitFor(() => {
      expect(firstRoute.fulfill).toHaveBeenCalledTimes(1);
      expect(secondRoute.fulfill).toHaveBeenCalledTimes(1);
    });
    releaseSecond();
    await Promise.resolve();
    expect(events).toEqual(["detected"]);
    releaseFirst();
    await expect(guarded).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(events).toEqual(["detected", "handled:true"]);
  });

  it("waits for in-flight policy work before returning", async () => {
    const { getRouteHandler, mainFrame, page, pageUnroute } = installBrowserMocks();
    let releasePolicy!: () => void;
    const policyPending = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => await policyPending);
    const route = createMockRoute();
    let settled = false;
    let dispatched: Promise<void> | undefined;
    let observedPolicyCheck: Promise<void> | undefined;

    try {
      const guarded = withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        onPolicyCheckStarted: (check) => {
          observedPolicyCheck = check;
        },
        action: async () => {
          dispatched = dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/page",
            route,
          });
          return "ok";
        },
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => expect(assertNavigationAllowedSpy).toHaveBeenCalledTimes(1));
      expect(observedPolicyCheck).toBeInstanceOf(Promise);
      expect(pageUnroute).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      releasePolicy();
      await expect(guarded).resolves.toBe("ok");
      await dispatched;
      expect(route.fallback).toHaveBeenCalledTimes(1);
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }
  });

  it("does not claim source preservation when 204 fulfillment falls back to abort", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const route = createMockRoute({
      fulfill: vi.fn(async () => {
        throw new Error("fulfill failed");
      }),
    });
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/private",
            route,
          });
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SsrFBlockedError);
    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });

  it("prefers a later policy denial over an earlier route failure", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const allowedRoute = createMockRoute({
      fallback: vi.fn(async () => {
        throw new Error("fallback transport failed");
      }),
    });
    const deniedRoute = createMockRoute();
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/allowed",
            route: allowedRoute,
          });
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/private",
            route: deniedRoute,
          });
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SsrFBlockedError);
    expect(allowedRoute.abort).toHaveBeenCalledTimes(1);
    expect(deniedRoute.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });

  it("removes its exact route when the action fails before a request", async () => {
    const { page, pageRoute, pageUnroute } = installBrowserMocks();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          throw new Error("locator failed");
        },
      }),
    ).rejects.toThrow("locator failed");

    expect(pageUnroute).toHaveBeenCalledWith("**", pageRoute.mock.calls[0]?.[1]);
  });

  it("rolls back its exact route when setup rejects", async () => {
    const { getRouteHandler, page, pageRoute, pageUnroute } = installBrowserMocks();
    const installRoute = pageRoute.getMockImplementation();
    const setupError = new Error("route setup failed");
    pageRoute.mockImplementationOnce(async (...args) => {
      await installRoute?.(...args);
      throw setupError;
    });
    const action = vi.fn(async () => "unreachable");

    await expect(
      withPageNavigationRequestGuard({ page, ssrfPolicy: strictPolicy, action }),
    ).rejects.toBe(setupError);

    expect(pageUnroute).toHaveBeenCalledWith("**", pageRoute.mock.calls[0]?.[1]);
    expect(getRouteHandler()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("ignores cleanup failure only after the action closes its page", async () => {
    const { page, pageUnroute } = installBrowserMocks();
    let closed = false;
    Object.assign(page, { isClosed: () => closed });
    pageUnroute.mockRejectedValueOnce(new Error("Target page has been closed"));

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          closed = true;
          return "closed";
        },
      }),
    ).resolves.toBe("closed");
  });

  it("surfaces cleanup failure while the page remains open", async () => {
    const { page, pageUnroute } = installBrowserMocks();
    Object.assign(page, { isClosed: () => false });
    const cleanupError = new Error("route cleanup failed");
    pageUnroute.mockRejectedValueOnce(cleanupError);

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => "ok",
      }),
    ).rejects.toBe(cleanupError);
  });
});
