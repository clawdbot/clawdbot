// Browser tests cover basic.existing session plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const { inspectChromeGraphicsDiagnosticsMock } = vi.hoisted(() => ({
  inspectChromeGraphicsDiagnosticsMock: vi.fn(),
}));

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
  takeChromeMcpSnapshot: vi.fn(async () => ({})),
}));

vi.mock("../chrome.graphics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chrome.graphics.js")>();
  return {
    ...actual,
    inspectChromeGraphicsDiagnostics: inspectChromeGraphicsDiagnosticsMock,
  };
});

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { getProfileLifecycle, ProfileRestartRequiredError } =
  await import("../server-context.lifecycle.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: {
  isHttpReachable?: (timeoutMs?: number) => Promise<boolean>;
  isTransportAvailable?: (timeoutMs?: number) => Promise<boolean>;
  isReachable?: (
    timeoutMs?: number,
    options?: { ephemeral?: boolean; signal?: AbortSignal },
  ) => Promise<boolean>;
}) {
  return {
    resolved: {
      enabled: true,
      headless: false,
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "chrome-live",
          driver: "existing-session",
          cdpPort: 0,
          cdpUrl: "",
          userDataDir: "/tmp/brave-profile",
          color: "#00AA00",
          executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          headless: false,
          attachOnly: true,
        },
        isHttpReachable: params?.isHttpReachable ?? (async () => true),
        isTransportAvailable: params?.isTransportAvailable ?? (async () => true),
        isReachable: params?.isReachable ?? (async () => true),
      }) as never,
  };
}

function readFirstReachabilityCall(
  isReachable: ReturnType<typeof vi.fn>,
): [number | undefined, { ephemeral?: boolean; signal?: AbortSignal } | undefined] {
  const [call] = isReachable.mock.calls as Array<
    [number | undefined, { ephemeral?: boolean; signal?: AbortSignal } | undefined]
  >;
  if (!call) {
    throw new Error("expected reachability probe call");
  }
  return call;
}

function createManagedProfileState(
  profileOverrides?: Record<string, unknown>,
  reachability?: {
    isHttpReachable?: () => Promise<boolean>;
    isTransportAvailable?: () => Promise<boolean>;
  },
) {
  return {
    resolved: {
      enabled: true,
      headless: false,
      headlessSource: "default",
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "openclaw",
          driver: "openclaw",
          cdpPort: 18800,
          cdpUrl: "http://127.0.0.1:18800",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          userDataDir: "/tmp/openclaw-profile",
          color: "#FF4500",
          headless: false,
          headlessSource: "default",
          attachOnly: false,
          ...profileOverrides,
        },
        isHttpReachable: reachability?.isHttpReachable ?? (async () => false),
        isTransportAvailable: reachability?.isTransportAvailable ?? (async () => false),
        isReachable: async () => false,
      }) as never,
  };
}

async function callBasicRouteWithState(params: {
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState>;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => params.state,
    forProfile: params.state.forProfile,
  } as never);

  const handler = getHandlers.get("/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? { profile: "chrome-live" } }, response.res);
  return response;
}

async function callStartRoute(params: {
  profile?: Record<string, unknown>;
  query?: Record<string, unknown>;
  error?: Error;
}) {
  const ensureBrowserAvailable = vi.fn(async () => {
    if (params.error) {
      throw params.error;
    }
  });
  const profile = {
    name: "openclaw",
    driver: "openclaw",
    cdpPort: 18800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    userDataDir: "/tmp/openclaw-profile",
    color: "#FF4500",
    headless: false,
    headlessSource: "default",
    attachOnly: false,
    ...params.profile,
  };
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => ({ resolved: { enabled: true, headless: false }, profiles: new Map() }),
    forProfile: () =>
      ({
        profile,
        ensureBrowserAvailable,
      }) as never,
  } as never);

  const handler = postHandlers.get("/start");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? {} }, response.res);
  return { response, ensureBrowserAvailable };
}

function responseBodyRecord(response: { body: unknown }): Record<string, unknown> {
  if (!response.body || typeof response.body !== "object") {
    throw new Error("expected JSON response body");
  }
  return response.body as Record<string, unknown>;
}

describe("basic browser routes", () => {
  beforeEach(() => {
    inspectChromeGraphicsDiagnosticsMock.mockReset();
  });

  it("releases the doctor transaction, restarts once, and retries the live probe", async () => {
    const ensureBrowserAvailable = vi.fn(async () => {});
    const ensureTabAvailable = vi
      .fn()
      .mockRejectedValueOnce(new ProfileRestartRequiredError())
      .mockResolvedValueOnce({
        targetId: "7",
        title: "",
        url: "https://example.com",
        type: "page",
      });
    const state = createExistingSessionProfileState();
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureBrowserAvailable,
      ensureTabAvailable,
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "chrome-live", deep: "true" } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(ensureBrowserAvailable).toHaveBeenCalledOnce();
    expect(ensureTabAvailable).toHaveBeenCalledTimes(2);
  });

  it("reports Linux no-display headless fallback for local managed profiles", async () => {
    const originalPlatform = process.platform;
    const originalDisplay = process.env.DISPLAY;
    const originalWayland = process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const response = await callBasicRouteWithState({
        query: { profile: "openclaw" },
        state: createManagedProfileState(),
      });

      expect(response.statusCode).toBe(200);
      const body = responseBodyRecord(response);
      expect(body.profile).toBe("openclaw");
      expect(body.headless).toBe(true);
      expect(body.headlessSource).toBe("linux-display-fallback");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalDisplay === undefined) {
        delete process.env.DISPLAY;
      } else {
        process.env.DISPLAY = originalDisplay;
      }
      if (originalWayland === undefined) {
        delete process.env.WAYLAND_DISPLAY;
      } else {
        process.env.WAYLAND_DISPLAY = originalWayland;
      }
    }
  });

  it("reports request-local headless source for tracked local launches", async () => {
    const state = createManagedProfileState();
    const profile = (state.forProfile() as { profile: unknown }).profile as never;
    state.profiles.set("openclaw", {
      profile,
      running: {
        pid: 222,
        exe: { kind: "chromium", path: "/usr/bin/chromium" },
        userDataDir: "/tmp/openclaw-profile",
        cdpPort: 18800,
        startedAt: Date.now(),
        proc: {} as never,
        headless: true,
        headlessSource: "request",
      },
    });

    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.profile).toBe("openclaw");
    expect(body.pid).toBe(222);
    expect(body.chosenBrowser).toBe("chromium");
    expect(body.headless).toBe(true);
    expect(body.headlessSource).toBe("request");
    expect(body.graphics).toBeNull();
    expect(inspectChromeGraphicsDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("reports and caches graphics diagnostics only for an owned managed process", async () => {
    const diagnostics = {
      status: "available",
      observedAt: 123,
      acceleration: "hardware",
      renderer: "ANGLE (Intel)",
      vendor: "Intel",
      version: "OpenGL ES 3.0",
      backend: "(gl=angle,angle=metal)",
      devices: [],
      featureStatus: { webgl: "enabled" },
      disabledFeatures: [],
      driverBugWorkarounds: [],
      videoDecoding: [],
      videoEncoding: [],
    } as const;
    inspectChromeGraphicsDiagnosticsMock.mockResolvedValue(diagnostics);
    const state = createManagedProfileState(
      {},
      {
        isHttpReachable: async () => true,
        isTransportAvailable: async () => true,
      },
    );
    const profile = (state.forProfile() as { profile: unknown }).profile as never;
    state.profiles.set("openclaw", {
      profile,
      running: {
        pid: 222,
        exe: { kind: "chromium", path: "/usr/bin/chromium" },
        userDataDir: "/tmp/openclaw-profile",
        cdpPort: 18800,
        startedAt: Date.now(),
        proc: {} as never,
      },
    });

    const first = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });
    const second = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });

    expect(responseBodyRecord(first).graphics).toEqual(diagnostics);
    expect(responseBodyRecord(second).graphics).toEqual(diagnostics);
    expect(inspectChromeGraphicsDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(inspectChromeGraphicsDiagnosticsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      expect.any(Object),
    );
  });

  it("does not inspect graphics while the managed process is pending reconcile", async () => {
    const state = createManagedProfileState(
      {},
      {
        isHttpReachable: async () => true,
        isTransportAvailable: async () => true,
      },
    );
    const profile = (state.forProfile() as { profile: unknown }).profile as never;
    const runtime = {
      profile,
      running: {
        pid: 222,
        exe: { kind: "chromium", path: "/usr/bin/chromium" },
        userDataDir: "/tmp/openclaw-profile",
        cdpPort: 18800,
        startedAt: Date.now(),
        proc: {} as never,
      },
    };
    state.profiles.set("openclaw", runtime);
    getProfileLifecycle(runtime as never).transitionReason = "cdp-port-changed";

    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });

    expect(response.statusCode).toBe(200);
    expect(responseBodyRecord(response).graphics).toBeNull();
    expect(inspectChromeGraphicsDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("does not inspect graphics when passive status sees no owned managed process", async () => {
    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state: createManagedProfileState(
        {},
        {
          isHttpReachable: async () => true,
          isTransportAvailable: async () => true,
        },
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(responseBodyRecord(response).graphics).toBeNull();
    expect(inspectChromeGraphicsDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("redacts CDP URL credentials from status responses", async () => {
    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state: createManagedProfileState({
        cdpUrl: "http://openclaw:relay-token@127.0.0.1:18800",
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.cdpUrl).toBe("http://127.0.0.1:18800");
  });

  it("maps existing-session status failures to JSON browser errors", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => {
          throw new BrowserProfileUnavailableError("attach failed");
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(responseBodyRecord(response).error).toBe("attach failed");
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.profile).toBe("chrome-live");
    expect(body.driver).toBe("existing-session");
    expect(body.transport).toBe("chrome-mcp");
    expect(body.running).toBe(true);
    expect(body.cdpPort).toBeNull();
    expect(body.cdpUrl).toBeNull();
    expect(body.userDataDir).toBe("/tmp/brave-profile");
    expect(body.executablePath).toBe(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
    expect(body.pid).toBe(4321);
  });

  it("passes valid start headless override to local managed profiles", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "true" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, profile: "openclaw" });
    expect(ensureBrowserAvailable).toHaveBeenCalledWith({ headless: true });
  });

  it("returns structured no-display metadata without replacing the error message", async () => {
    const { response } = await callStartRoute({
      error: new BrowserProfileUnavailableError("display required", {
        metadata: {
          reason: "no_display_for_headed_profile",
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "profile",
            displayPresent: false,
          },
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "display required",
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "profile",
        displayPresent: false,
      },
    });
  });

  it("rejects invalid start headless values", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "maybe" },
    });

    expect(response.statusCode).toBe(400);
    expect(responseBodyRecord(response).error).toBe(
      'Invalid headless value. Use "true" or "false".',
    );
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("rejects start headless override for existing-session profiles", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      profile: {
        name: "chrome-live",
        driver: "existing-session",
        cdpPort: 0,
        cdpUrl: "",
        cdpHost: "",
        cdpIsLoopback: true,
        attachOnly: true,
      },
      query: { headless: "true" },
    });

    expect(response.statusCode).toBe(400);
    expect(responseBodyRecord(response).error).toBe(
      'Headless start override is only supported for locally launched openclaw profiles. Profile "chrome-live" is attach-only, remote, or existing-session.',
    );
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("reports pageReady=false when Chrome MCP transport is up but page tools are unreachable", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable: async () => false,
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.profile).toBe("chrome-live");
    expect(body.driver).toBe("existing-session");
    expect(body.transport).toBe("chrome-mcp");
    expect(body.running).toBe(true);
    expect(body.cdpReady).toBe(true);
    expect(body.pageReady).toBe(false);
  });

  it("reports pageReady=false when the page-reachability probe throws", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable: async () => {
          throw new Error('Chrome MCP "list_pages" timed out after 5000ms.');
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.cdpReady).toBe(true);
    expect(body.pageReady).toBe(false);
  });

  it("reports pageReady=true when both transport and page tools succeed", async () => {
    const isHttpReachable = vi.fn(async () => true);
    const isTransportAvailable = vi.fn(async () => true);
    const isReachable = vi.fn(async () => true);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable,
        isTransportAvailable,
        isReachable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isTransportAvailable).toHaveBeenCalledTimes(1);
    expect(isTransportAvailable).toHaveBeenCalledWith(5_000);
    const [timeoutMs, reachabilityOptions] = readFirstReachabilityCall(isReachable);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(7_000);
    expect(reachabilityOptions?.ephemeral).toBe(true);
    expect(reachabilityOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(isHttpReachable).not.toHaveBeenCalled();
    const body = responseBodyRecord(response);
    expect(body.cdpHttp).toBe(true);
    expect(body.cdpReady).toBe(true);
    expect(body.pageReady).toBe(true);
    expect(body.running).toBe(true);
  });

  it("keeps Chrome MCP page-readiness inside the status budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const isReachable = vi.fn(async () => true);
    try {
      const response = await callBasicRouteWithState({
        state: createExistingSessionProfileState({
          isTransportAvailable: async () => {
            vi.setSystemTime(4_000);
            return true;
          },
          isReachable,
        }),
      });

      expect(response.statusCode).toBe(200);
      const [timeoutMs, reachabilityOptions] = readFirstReachabilityCall(isReachable);
      expect(timeoutMs).toBe(4_000);
      expect(reachabilityOptions?.ephemeral).toBe(true);
      expect(reachabilityOptions?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("page-readiness probe runs in ephemeral mode so status does not seed a cached session", async () => {
    const isReachable = vi.fn<
      (
        timeoutMs?: number,
        options?: { ephemeral?: boolean; signal?: AbortSignal },
      ) => Promise<boolean>
    >(async () => true);

    await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable,
      }),
    });

    expect(isReachable).toHaveBeenCalledTimes(1);
    const [, reachabilityOptions] = readFirstReachabilityCall(isReachable);
    expect(reachabilityOptions?.ephemeral).toBe(true);
    expect(reachabilityOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it("skips the page-reachability probe when transport is unavailable", async () => {
    const isReachable = vi.fn(async () => true);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => false,
        isReachable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isReachable).not.toHaveBeenCalled();
    const body = responseBodyRecord(response);
    expect(body.cdpReady).toBe(false);
    expect(body.pageReady).toBe(false);
    expect(body.running).toBe(false);
  });
});
