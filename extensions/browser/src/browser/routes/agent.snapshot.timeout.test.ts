import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const cdpMocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  snapshotAria: vi.fn(async () => ({ nodes: [] })),
  snapshotRoleViaCdp: vi.fn(async () => ({
    snapshot: "button Continue",
    refs: {},
    stats: { lines: 1, chars: 15, refs: 0, interactive: 0 },
  })),
}));

const profileContext = vi.hoisted(() => ({
  profile: {
    name: "openclaw",
    driver: "openclaw" as const,
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#FF4500",
    headless: false,
    attachOnly: false,
  },
  ensureTabAvailable: vi.fn(async () => ({
    targetId: "tab-1",
    url: "https://example.com",
    wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
  })),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: cdpMocks.captureScreenshot,
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
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
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
  getPwAiModule: vi.fn(async () => null),
  handleRouteError: vi.fn(),
  readBody: vi.fn((req: { body?: unknown }) => req.body ?? {}),
  requirePwAi: vi.fn(async () => null),
  resolveProfileContext: vi.fn(() => profileContext),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(),
}));

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

function getSnapshotHandler() {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: {} }),
  } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("browser agent snapshot timeout routing", () => {
  beforeEach(() => {
    cdpMocks.captureScreenshot.mockClear();
    cdpMocks.snapshotAria.mockClear();
    cdpMocks.snapshotRoleViaCdp.mockClear();
    profileContext.ensureTabAvailable.mockClear();
  });

  it("passes timeoutMs to direct CDP aria snapshots", async () => {
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "aria", timeoutMs: "4321" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
        timeoutMs: 4321,
      }),
    );
  });

  it("passes timeoutMs to direct CDP role snapshots", async () => {
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", timeoutMs: "9876" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.snapshotRoleViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
        timeoutMs: 9876,
      }),
    );
  });
});
