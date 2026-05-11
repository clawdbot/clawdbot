import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: {
  isHttpReachable?: () => Promise<boolean>;
  isTransportAvailable?: () => Promise<boolean>;
  isReachable?: () => Promise<boolean>;
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

function createManagedProfileState() {
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
        },
        isHttpReachable: async () => false,
        isTransportAvailable: async () => false,
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
}) {
  const ensureBrowserAvailable = vi.fn(async () => {});
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

  it("treats attach-only profiles as running when transport is available even if page reachability is false", async () => {
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
  });

  it("probes Chrome MCP transport only once for status", async () => {
    const isHttpReachable = vi.fn(async () => true);
    const isTransportAvailable = vi.fn(async () => true);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable,
        isTransportAvailable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isTransportAvailable).toHaveBeenCalledTimes(1);
    expect(isTransportAvailable).toHaveBeenCalledWith(5_000);
    expect(isHttpReachable).not.toHaveBeenCalled();
    const body = responseBodyRecord(response);
    expect(body.cdpHttp).toBe(true);
    expect(body.cdpReady).toBe(true);
    expect(body.running).toBe(true);
  });
});
