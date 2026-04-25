import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";
import { getFreePort } from "./test-port.js";

type EnsureBrowserControlAuthResult = {
  auth: {
    token?: string;
    password?: string;
  };
  generatedToken?: string;
};

const mocks = vi.hoisted(() => ({
  controlPort: 0,
  gatewayAuthMode: undefined as "password" | undefined,
  gatewayAuthToken: undefined as string | undefined,
  ensureBrowserControlAuth: vi.fn<() => Promise<EnsureBrowserControlAuthResult>>(async () => {
    throw new Error("read-only config");
  }),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => true),
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const browserConfig = {
    enabled: true,
  };
  return {
    ...actual,
    loadConfig: () => {
      return {
        browser: browserConfig,
        ...(mocks.gatewayAuthMode || mocks.gatewayAuthToken
          ? { gateway: { auth: { mode: mocks.gatewayAuthMode, token: mocks.gatewayAuthToken } } }
          : {}),
      };
    },
  };
});

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: mocks.controlPort,
    })),
  };
});

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

vi.mock("./routes/index.js", () => ({
  registerBrowserRoutes: vi.fn(() => {}),
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: vi.fn(() => false),
}));

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.gatewayAuthMode = undefined;
    mocks.gatewayAuthToken = undefined;
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.shouldAutoGenerateBrowserAuth.mockClear();
    mocks.ensureExtensionRelayForProfiles.mockClear();
  });

  afterEach(async () => {
    await stopBrowserControlServer();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when auth bootstrap resolves empty auth in production-like mode", async () => {
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when password mode has no resolved password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when password mode drops an inactive token but has no password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.gatewayAuthToken = "inactive-token";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });
});
