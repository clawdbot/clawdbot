import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

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
    })),
  },
}));

const cdpMocks = vi.hoisted(() => ({
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "private", depth: 0 }],
  })),
  snapshotRoleViaCdp: vi.fn(async () => ({
    snapshot: '- link "private" [ref=e1]',
    refs: { e1: { role: "link", name: "private" } },
    stats: { lines: 1, chars: 25, refs: 1, interactive: 1 },
  })),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {
    throw new Error("browser navigation blocked by policy");
  }),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
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

function getSnapshotGetHandler() {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({
      resolved: {
        extraArgs: [],
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      },
    }),
  } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("local-managed browser snapshot routes", () => {
  beforeEach(() => {
    routeState.profileCtx.ensureTabAvailable.mockClear();
    cdpMocks.snapshotAria.mockClear();
    cdpMocks.snapshotRoleViaCdp.mockClear();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockClear();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
  });

  it("blocks ARIA CDP snapshots when the current tab violates browser navigation policy", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "aria" } }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "browser navigation blocked by policy" });
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
});
