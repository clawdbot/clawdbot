import { afterEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "../browser/test-port.js";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  runtimeConfig: {} as OpenClawConfig,
  runtimeSourceConfig: null as OpenClawConfig | null,
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: {} })),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => false),
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
  stopKnownBrowserProfiles: vi.fn(async () => {}),
  isChromeReachable: vi.fn(async () => false),
  isChromeCdpReady: vi.fn(async () => false),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.runtimeConfig,
    getRuntimeConfigSourceSnapshot: () => mocks.runtimeSourceConfig,
    loadConfig: () => mocks.runtimeConfig,
  };
});

vi.mock("../browser/control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

vi.mock("../browser/server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: mocks.stopKnownBrowserProfiles,
}));

vi.mock("../browser/chrome.js", () => ({
  diagnoseChromeCdp: vi.fn(async () => ({ ok: false })),
  formatChromeCdpDiagnostic: vi.fn(() => "not reachable"),
  isChromeCdpReady: mocks.isChromeCdpReady,
  isChromeReachable: mocks.isChromeReachable,
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("launch should not be needed for status");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-browser"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

vi.mock("../browser/pw-ai-state.js", () => ({
  isPwAiLoaded: vi.fn(() => false),
}));

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("../server.js");
const { stopBrowserControlService } = await import("../control-service.js");
const { browserHandlers } = await import("./browser-request.js");

function browserConfig(params: {
  gatewayPort: number;
  executablePath?: string;
  headless?: boolean;
  noSandbox?: boolean;
}): OpenClawConfig {
  return {
    gateway: {
      port: params.gatewayPort,
    },
    browser: {
      enabled: true,
      defaultProfile: "openclaw",
      ...(params.executablePath ? { executablePath: params.executablePath } : {}),
      ...(typeof params.headless === "boolean" ? { headless: params.headless } : {}),
      ...(typeof params.noSandbox === "boolean" ? { noSandbox: params.noSandbox } : {}),
      profiles: {
        openclaw: {
          cdpPort: params.gatewayPort + 11,
          color: "#FF4500",
        },
      },
    },
  };
}

async function browserRequestStatus(): Promise<unknown> {
  const respond = vi.fn();
  await browserHandlers["browser.request"]({
    params: {
      method: "GET",
      path: "/",
      query: { profile: "openclaw" },
    },
    respond: respond as never,
    context: {
      nodeRegistry: {
        listConnected: () => [],
      },
    } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
  });
  const [call] = respond.mock.calls;
  if (!call) {
    throw new Error("expected browser request response");
  }
  expect(call[0]).toBe(true);
  return call[1];
}

describe("browser.request local control state", () => {
  afterEach(async () => {
    await stopBrowserControlService();
    await stopBrowserControlServer();
    mocks.runtimeSourceConfig = null;
    vi.clearAllMocks();
  });

  it("uses the same resolved browser config as the HTTP control service", async () => {
    const controlPort = await getFreePort();
    const gatewayPort = controlPort - 2;

    mocks.runtimeConfig = browserConfig({
      gatewayPort,
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      noSandbox: true,
    });
    mocks.runtimeSourceConfig = mocks.runtimeConfig;
    const httpState = await startBrowserControlServerFromConfig();
    expect(httpState?.resolved.executablePath).toBe("/usr/bin/google-chrome");
    expect(httpState?.resolved.noSandbox).toBe(true);

    // The runtime snapshot can lag behind source config after gateway startup;
    // browser.request must not fork a second stale control state from it.
    mocks.runtimeConfig = browserConfig({
      gatewayPort,
      headless: false,
      noSandbox: false,
    });

    const status = (await browserRequestStatus()) as {
      executablePath?: unknown;
      headless?: unknown;
      noSandbox?: unknown;
    };
    expect(status.executablePath).toBe("/usr/bin/google-chrome");
    expect(status.headless).toBe(true);
    expect(status.noSandbox).toBe(true);
  });
});
