// Browser tests cover server.auth fail closed plugin behavior.
import { createServer } from "node:http";
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
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const browserConfig = {
    enabled: true,
  };
  const loadConfig = () => {
    return {
      browser: browserConfig,
      ...(mocks.gatewayAuthMode || mocks.gatewayAuthToken
        ? { gateway: { auth: { mode: mocks.gatewayAuthMode, token: mocks.gatewayAuthToken } } }
        : {}),
    };
  };
  return {
    ...actual,
    getRuntimeConfig: loadConfig,
    loadConfig,
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
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.gatewayAuthMode = undefined;
    mocks.gatewayAuthToken = undefined;
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.shouldAutoGenerateBrowserAuth.mockClear();
  });

  afterEach(async () => {
    await stopBrowserControlServer();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
  });

  it("fails closed when auth bootstrap resolves empty auth in production-like mode", async () => {
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
  });

  it("fails closed when password mode has no resolved password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
  });

  it("fails closed when password mode drops an inactive token but has no password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.gatewayAuthToken = "inactive-token";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
  });

  it("returns null when the browser control port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected blocker TCP address");
    }
    mocks.controlPort = address.port;
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: { token: "test-token" } });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({ token: "test-token" });
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(false);

    try {
      await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });
});
