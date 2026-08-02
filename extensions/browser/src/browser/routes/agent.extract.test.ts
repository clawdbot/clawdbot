// Browser tests cover the agent extract capture route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  profileCtx: {
    profile: {
      name: "openclaw",
      driver: "openclaw" as "openclaw" | "existing-session",
      cdpUrl: "http://127.0.0.1:18800",
      cdpIsLoopback: true,
    },
  },
  pageContentViaPlaywright: vi.fn<
    () => Promise<
      | { ok: true; html: string }
      | {
          ok: false;
          error: "invalid_selector" | "selector_not_found";
        }
    >
  >(async () => ({
    ok: true,
    html: "<main>Private page body</main>",
  })),
  withPlaywrightRouteContext: vi.fn(),
}));

vi.mock("./agent.shared.js", () => ({
  readBody: (req: BrowserRequest) => req.body ?? {},
  resolveProfileContext: () => routeState.profileCtx,
  withPlaywrightRouteContext: routeState.withPlaywrightRouteContext,
}));

const { registerBrowserExtractRoute } = await import("./agent.extract.js");

type PlaywrightRouteParams = {
  req: BrowserRequest;
  run: (ctx: {
    cdpUrl: string;
    tab: { targetId: string; url: string };
    signal: AbortSignal;
    resolveTabUrl: (fallback?: string) => Promise<string | undefined>;
    pw: { pageContentViaPlaywright: typeof routeState.pageContentViaPlaywright };
  }) => Promise<unknown>;
};

function getExtractHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserExtractRoute(app, {
    state: () => ({ resolved: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } } }),
  } as never);
  const handler = postHandlers.get("/extract");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("browser extract route", () => {
  beforeEach(() => {
    routeState.profileCtx.profile.driver = "openclaw";
    routeState.pageContentViaPlaywright.mockClear();
    routeState.withPlaywrightRouteContext
      .mockReset()
      .mockImplementation(async (params: PlaywrightRouteParams) => {
        await params.run({
          cdpUrl: routeState.profileCtx.profile.cdpUrl,
          tab: { targetId: "t1", url: "https://example.com" },
          signal: params.req.signal ?? new AbortController().signal,
          resolveTabUrl: async () => "https://example.com",
          pw: { pageContentViaPlaywright: routeState.pageContentViaPlaywright },
        });
      });
  });

  it("captures resolved page HTML through Playwright", async () => {
    const response = createBrowserRouteResponse();
    await getExtractHandler()?.(
      { params: {}, query: {}, body: { targetId: "t1", timeoutMs: 60_000 } },
      response.res,
    );

    expect(response.body).toEqual({
      ok: true,
      targetId: "t1",
      url: "https://example.com",
      html: "<main>Private page body</main>",
    });
    expect(routeState.pageContentViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "t1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: expect.any(AbortSignal),
      selector: undefined,
      ignoreSelectors: [],
    });
  });

  it("forwards selector scoping and ignored nodes to Playwright capture", async () => {
    const response = createBrowserRouteResponse();
    await getExtractHandler()?.(
      {
        params: {},
        query: {},
        body: { selector: "main", ignoreSelectors: ["nav", "footer"] },
      },
      response.res,
    );

    expect(routeState.pageContentViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "main", ignoreSelectors: ["nav", "footer"] }),
    );
  });

  it("returns a selector no-match result without falling back to the full page", async () => {
    routeState.pageContentViaPlaywright.mockResolvedValueOnce({
      ok: false,
      error: "selector_not_found",
      message: "hostile page-controlled text",
    } as never);
    const response = createBrowserRouteResponse();
    await getExtractHandler()?.(
      { params: {}, query: {}, body: { selector: ".missing" } },
      response.res,
    );

    expect(response.body).toEqual({
      ok: false,
      error: "selector_not_found",
      message:
        'CSS selector ".missing" matched no usable elements; check selector and ignoreSelectors, or omit selector to extract the whole page.',
      targetId: "t1",
      url: "https://example.com",
    });
  });

  it("returns 501 for existing-session profiles", async () => {
    routeState.profileCtx.profile.driver = "existing-session";
    const response = createBrowserRouteResponse();
    await getExtractHandler()?.({ params: {}, query: {}, body: { targetId: "t1" } }, response.res);

    expect(response.statusCode).toBe(501);
    expect(response.body).toEqual({ error: EXISTING_SESSION_LIMITS.extract });
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
  });

  it("rejects oversized HTML before returning it to the caller", async () => {
    routeState.pageContentViaPlaywright.mockResolvedValueOnce({
      ok: true,
      html: "x".repeat(2_000_001),
    });
    const response = createBrowserRouteResponse();
    await getExtractHandler()?.({ params: {}, query: {}, body: {} }, response.res);

    expect(response.statusCode).toBe(413);
    expect(response.body).toEqual({
      error: "page HTML exceeds the 2000000 character extraction limit; use snapshot instead.",
    });
  });
});
