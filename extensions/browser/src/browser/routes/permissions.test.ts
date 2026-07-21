// Browser tests cover permissions plugin behavior.
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

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: pwMocks.getPwAiModule,
}));

// The Browser Vitest project is non-isolated. Reload after installing mocks so
// an earlier routes/index import cannot retain the real CDP dependencies.
vi.resetModules();

const { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserPermissionRoutes } = await import("./permissions.js");

function createProfileContext(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      name: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      driver: "openclaw",
      ...overrides,
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

function createRouteContext(
  profileCtx: ReturnType<typeof createProfileContext>,
  ssrfPolicy: Record<string, unknown> = { allowPrivateNetwork: false },
) {
  return {
    state: () => ({ resolved: { ssrfPolicy } }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(() => null),
    ...profileCtx,
  };
}

async function callGrant(
  body: Record<string, unknown>,
  options: {
    profile?: Record<string, unknown>;
    ssrfPolicy?: Record<string, unknown>;
    ensureBrowserAvailable?: () => Promise<void>;
  } = {},
) {
  const { app, postHandlers } = createBrowserRouteApp();
  const profileCtx = createProfileContext(options.profile);
  if (options.ensureBrowserAvailable) {
    profileCtx.ensureBrowserAvailable = vi.fn(options.ensureBrowserAvailable);
  }
  registerBrowserPermissionRoutes(app, createRouteContext(profileCtx, options.ssrfPolicy) as never);
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
    pwMocks.getPwAiModule.mockReset().mockResolvedValue(null);
    pwMocks.getPageForTargetId.mockClear();
    pwMocks.grantPermissions.mockClear();
  });

  it("uses Playwright context permissions for attached pages when available", async () => {
    pwMocks.getPwAiModule.mockResolvedValue({
      getPageForTargetId: pwMocks.getPageForTargetId,
    } as never);

    const { response } = await callGrant({
      origin: "https://meet.google.com/abc-defg-hij",
      permissions: ["audioCapture", "videoCapture"],
      optionalPermissions: ["speakerSelection"],
      targetId: "meet-tab",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toStrictEqual({
      ok: true,
      origin: "https://meet.google.com",
      grantedPermissions: ["audioCapture", "videoCapture"],
      unsupportedPermissions: ["speakerSelection"],
      grantMethod: "playwright",
    });
    expect(pwMocks.getPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "meet-tab",
      ssrfPolicy: undefined,
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
    expect(response.body).toStrictEqual({
      ok: true,
      origin: "https://meet.google.com",
      grantedPermissions: ["audioCapture", "videoCapture", "speakerSelection"],
      unsupportedPermissions: [],
      grantMethod: "cdp",
    });
    expect(profileCtx.ensureBrowserAvailable).toHaveBeenCalled();
    expect(cdpMocks.getChromeWebSocketUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      1234,
      undefined,
    );
    expect(cdpMocks.send).toHaveBeenCalledWith("Browser.grantPermissions", {
      origin: "https://meet.google.com",
      permissions: ["audioCapture", "videoCapture", "speakerSelection"],
    });
  });

  it("preserves structured browser availability errors", async () => {
    const error = new BrowserProfileUnavailableError(
      'Managed browser profile "openclaw" requires a display.',
      {
        metadata: {
          reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "config",
            displayPresent: false,
          },
        },
      },
    );
    const { response } = await callGrant(
      {
        origin: "https://meet.google.com",
        permissions: ["audioCapture"],
      },
      {
        ensureBrowserAvailable: async () => {
          throw error;
        },
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toStrictEqual({
      error: error.message,
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "config",
        displayPresent: false,
      },
    });
    expect(cdpMocks.getChromeWebSocketUrl).not.toHaveBeenCalled();
  });

  it("rejects loose timeoutMs values before granting permissions", async () => {
    const { response, profileCtx } = await callGrant({
      origin: "https://meet.google.com",
      permissions: ["audioCapture"],
      timeoutMs: "1e3",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toStrictEqual({ error: "timeoutMs must be a positive integer." });
    expect(profileCtx.ensureBrowserAvailable).not.toHaveBeenCalled();
    expect(cdpMocks.getChromeWebSocketUrl).not.toHaveBeenCalled();
    expect(cdpMocks.send).not.toHaveBeenCalled();
  });

  it("keeps the minimum permission timeout for small valid values", async () => {
    const { response } = await callGrant({
      origin: "https://meet.google.com",
      permissions: ["audioCapture"],
      timeoutMs: "1",
    });

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.getChromeWebSocketUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      1000,
      undefined,
    );
  });

  it("uses exact remote CDP control policy for permission discovery", async () => {
    const { response } = await callGrant(
      {
        origin: "https://meet.google.com",
        permissions: ["audioCapture"],
      },
      {
        profile: {
          name: "remote",
          cdpUrl: "https://browser.example:9222",
          cdpHost: "browser.example",
          cdpIsLoopback: false,
        },
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedOrigins: ["https://navigation.example"],
        },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.getChromeWebSocketUrl).toHaveBeenCalledWith(
      "https://browser.example:9222",
      5000,
      {
        allowPrivateNetwork: true,
        allowedHostnames: ["browser.example"],
      },
    );
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
    expect(response.body).toStrictEqual({
      ok: true,
      origin: "https://meet.google.com",
      grantedPermissions: ["audioCapture", "videoCapture"],
      unsupportedPermissions: ["speakerSelection"],
      grantMethod: "cdp",
    });
    expect(cdpMocks.send).toHaveBeenNthCalledWith(2, "Browser.grantPermissions", {
      origin: "https://meet.google.com",
      permissions: ["audioCapture", "videoCapture"],
    });
  });
});
