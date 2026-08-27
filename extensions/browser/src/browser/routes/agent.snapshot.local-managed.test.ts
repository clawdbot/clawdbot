// Browser tests cover agent.snapshot.local managed plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const tabLookup = vi.hoisted(() => vi.fn());

const routeState = vi.hoisted(() => ({
  profileCtx: {
    profile: {
      driver: "openclaw" as const,
      name: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
      cdpIsLoopback: true,
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "http://127.0.0.1:8080/admin",
      wsUrl: "ws://127.0.0.1/devtools/page/7",
      wsLookup: tabLookup,
    })),
  },
}));

const cdpMocks = vi.hoisted(() => ({
  getMainFrameDocumentIdentityViaCdp: vi.fn<(_opts?: unknown) => Promise<string | undefined>>(
    async () => "cdp:test-document",
  ),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "private", depth: 0 }],
  })),
  snapshotRoleViaCdp: vi.fn(async (_opts: unknown) => ({
    snapshot: '- link "private" [ref=e1]',
    refs: { e1: { role: "link", name: "private" } },
    stats: { lines: 1, chars: 25, refs: 1, interactive: 1 },
  })),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async (): Promise<void> => {
    throw new Error("browser navigation blocked by policy");
  }),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  getMainFrameDocumentIdentityViaCdp: cdpMocks.getMainFrameDocumentIdentityViaCdp,
  snapshotAria: cdpMocks.snapshotAria,
  snapshotRoleViaCdp: cdpMocks.snapshotRoleViaCdp,
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: navigationGuardMocks.assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed: navigationGuardMocks.assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy: navigationGuardMocks.withBrowserNavigationPolicy,
}));

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({
    buffer,
    contentType: "image/png",
  })),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./agent.shared.js", () => ({
  browserNavigationPolicyForProfile: vi.fn(() => ({
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
  })),
  getPwAiModule: vi.fn(async () => null),
  handleRouteError: vi.fn(
    (
      _ctx: unknown,
      res: { status: (code: number) => unknown; json: (body: unknown) => void },
      err: unknown,
    ) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400);
      res.json({ error: message });
    },
  ),
  readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
  requirePwAi: vi.fn(async () => null),
  resolveProfileContext: vi.fn(() => routeState.profileCtx),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(),
}));

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

function getSnapshotGetHandler(
  state = {
    resolved: {
      actionTimeoutMs: 60_000,
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    },
  },
) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, { state: () => state } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("local-managed browser snapshot routes", () => {
  beforeEach(() => {
    routeState.profileCtx.ensureTabAvailable.mockClear();
    cdpMocks.getMainFrameDocumentIdentityViaCdp.mockReset().mockResolvedValue("cdp:test-document");
    cdpMocks.snapshotAria.mockClear();
    cdpMocks.snapshotRoleViaCdp.mockClear();
    tabLookup.mockClear();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockClear();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
  });

  it("blocks ARIA CDP snapshots when the current tab violates browser navigation policy", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "aria" } }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "browser navigation blocked by policy" });
    expect(routeState.profileCtx.ensureTabAvailable).toHaveBeenCalledWith(undefined, {
      allowPlaywrightFallback: false,
      signal: expect.any(AbortSignal),
      timeoutMs: undefined,
    });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(cdpMocks.snapshotAria).not.toHaveBeenCalled();
  });

  it("blocks AI CDP role snapshots when the current tab violates browser navigation policy", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "browser navigation blocked by policy" });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(cdpMocks.snapshotRoleViaCdp).not.toHaveBeenCalled();
  });

  it("forwards the resolved snapshot budget to raw CDP role snapshots", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined);
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: { format: "ai", interactive: "true", maxChars: "123" } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.snapshotRoleViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({ maxChars: 123 }),
    );
  });

  it("rejects a snapshot when the main-frame loader changes during capture", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined);
    cdpMocks.getMainFrameDocumentIdentityViaCdp
      .mockResolvedValueOnce("cdp:before")
      .mockResolvedValueOnce("cdp:after");
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "Frame changed while its browser snapshot was being captured; retry.",
    });
  });

  it("uses the tab lookup pin when reading delta document identity via CDP", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.getMainFrameDocumentIdentityViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "ws://127.0.0.1/devtools/page/7",
        lookup: tabLookup,
      }),
    );
  });

  it("disables deltas when no stable document identity is available", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    cdpMocks.getMainFrameDocumentIdentityViaCdp.mockResolvedValue(undefined);
    const handler = getSnapshotGetHandler();
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, first.res);
    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, second.res);

    const calls = cdpMocks.snapshotRoleViaCdp.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({ delta: undefined });
    expect(calls[1]?.[0]).toMatchObject({ delta: undefined });
    expect(second.body).not.toHaveProperty("newElements");
    expect(second.body).not.toHaveProperty("snapshot", expect.stringContaining("[new]"));
  });

  it("reuses delta keys when the stable document identity is unchanged", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    const handler = getSnapshotGetHandler();
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, first.res);
    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, second.res);

    const secondCall = cdpMocks.snapshotRoleViaCdp.mock.calls[1]?.[0];
    expect(secondCall).toMatchObject({
      delta: { mode: "role", previousKeys: expect.any(Set) },
    });
  });

  it("reuses same-document delta keys across request contexts in one browser runtime", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    const state = {
      resolved: {
        actionTimeoutMs: 60_000,
        extraArgs: [],
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      },
    };
    const firstHandler = getSnapshotGetHandler(state);
    const secondHandler = getSnapshotGetHandler(state);
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();
    const request = { params: {}, query: { format: "ai", interactive: "true" } };

    await firstHandler?.(request, first.res);
    await secondHandler?.(request, second.res);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cdpMocks.snapshotRoleViaCdp.mock.calls[1]?.[0]).toMatchObject({
      delta: { mode: "role", previousKeys: expect.any(Set) },
    });
  });
});
