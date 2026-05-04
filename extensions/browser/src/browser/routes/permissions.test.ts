import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const cdpMocks = vi.hoisted(() => ({
  getChromeWebSocketUrl: vi.fn(async () => "ws://127.0.0.1:18800/devtools/browser/test"),
  send: vi.fn(
    async (
      _method: string,
      _params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => ({}),
  ),
  withCdpSocket: vi.fn(
    async (
      _wsUrl: string,
      fn: (
        send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
      ) => Promise<unknown>,
    ) => await fn(cdpMocks.send),
  ),
}));

const pwMocks = vi.hoisted(() => ({
  getPwAiModule: vi.fn(async () => null),
  grantPermissions: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => ({
    context: () => ({
      grantPermissions: pwMocks.grantPermissions,
    }),
  })),
}));

vi.mock("../chrome.js", () => ({
  getChromeWebSocketUrl: cdpMocks.getChromeWebSocketUrl,
}));

vi.mock("../cdp.helpers.js", () => ({
  withCdpSocket: cdpMocks.withCdpSocket,
}));

const { registerBrowserPermissionRoutes, __testing } = await import("./permissions.js");

function createProfileContext() {
  return {
    profile: {
      name: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
    },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(),
    isHttpReachable: vi.fn(),
    isTransportAvailable: vi.fn(),
    isReachable: vi.fn(),
    listTabs: vi.fn(),
    openTab: vi.fn(),
    labelTab: vi.fn(),
    focusTab: vi.fn(),
    closeTab: vi.fn(),
    stopRunningBrowser: vi.fn(),
    resetProfile: vi.fn(),
  };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    state: () => ({ resolved: { ssrfPolicy: { allowPrivateNetwork: false } } }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(() => null),
    ...profileCtx,
  };
}

async function callGrant(body: Record<string, unknown>) {
  const { app, postHandlers } = createBrowserRouteApp();
  const profileCtx = createProfileContext();
  registerBrowserPermissionRoutes(app, createRouteContext(profileCtx) as never);
  const handler = postHandlers.get("/permissions/grant");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body }, response.res);
  return { response, profileCtx };
}

describe("browser permission routes", () => {
  beforeEach(() => {
    cdpMocks.getChromeWebSocketUrl.mockClear();
    cdpMocks.send.mockReset().mockResolvedValue({});
    cdpMocks.withCdpSocket.mockClear();
    __testing.setDepsForTest(null);
    pwMocks.getPwAiModule.mockReset().mockResolvedValue(null);
    pwMocks.getPageForTargetId.mockClear();
    pwMocks.grantPermissions.mockClear();
  });

  it("uses Playwright context permissions for attached pages when available", async () => {
    pwMocks.getPwAiModule.mockResolvedValue({
      getPageForTargetId: pwMocks.getPageForTargetId,
    } as never);
    __testing.setDepsForTest({ getPwAiModule: pwMocks.getPwAiModule as never });

    const { response } = await callGrant({
      origin: "https://meet.google.com/abc-defg-hij",
      permissions: ["audioCapture", "videoCapture"],
      optionalPermissions: ["speakerSelection"],
      targetId: "meet-tab",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      origin: "https://meet.google.com",
      grantedPermissions: ["audioCapture", "videoCapture"],
      unsupportedPermissions: ["speakerSelection"],
      grantMethod: "playwright",
    });
    expect(pwMocks.getPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "meet-tab",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(pwMocks.grantPermissions).toHaveBeenCalledWith(["microphone", "camera"], {
      origin: "https://meet.google.com",
    });
    expect(cdpMocks.send).not.toHaveBeenCalled();
  });

  it("grants required and optional Chrome permissions for an origin", async () => {
    const { response, profileCtx } = await callGrant({
      origin: "https://meet.google.com/abc-defg-hij",
      permissions: ["audioCapture", "videoCapture"],
      optionalPermissions: ["speakerSelection"],
      timeoutMs: 1234,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      origin: "https://meet.google.com",
      grantedPermissions: ["audioCapture", "videoCapture", "speakerSelection"],
      unsupportedPermissions: [],
    });
    expect(profileCtx.ensureBrowserAvailable).toHaveBeenCalled();
    expect(cdpMocks.getChromeWebSocketUrl).toHaveBeenCalledWith("http://127.0.0.1:18800", 1234, {
      allowPrivateNetwork: false,
    });
    expect(cdpMocks.send).toHaveBeenCalledWith("Browser.grantPermissions", {
      origin: "https://meet.google.com",
      permissions: ["audioCapture", "videoCapture", "speakerSelection"],
    });
  });

  it("keeps required permissions when an optional permission is unsupported", async () => {
    cdpMocks.send.mockImplementation(async (_method: string, params?: Record<string, unknown>) => {
      const permissions = Array.isArray(params?.permissions) ? params.permissions : [];
      if (permissions.includes("speakerSelection")) {
        throw new Error("Unknown permission type");
      }
      return {};
    });

    const { response } = await callGrant({
      origin: "https://meet.google.com",
      permissions: ["audioCapture", "videoCapture"],
      optionalPermissions: ["speakerSelection"],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      grantedPermissions: ["audioCapture", "videoCapture"],
      unsupportedPermissions: ["speakerSelection"],
    });
    expect(cdpMocks.send).toHaveBeenNthCalledWith(2, "Browser.grantPermissions", {
      origin: "https://meet.google.com",
      permissions: ["audioCapture", "videoCapture"],
    });
  });
});
