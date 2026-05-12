import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

let BROWSER_BRIDGES: Map<string, unknown>;
let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
let resetNoVncObserverTokensForTests: typeof import("./novnc-auth.js").resetNoVncObserverTokensForTests;

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerContainerEnvVar: vi.fn(),
  readDockerContainerLabel: vi.fn(),
  readDockerNetworkDriver: vi.fn(),
  readDockerNetworkGateway: vi.fn(),
  readDockerPort: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  updateBrowserRegistry: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    execDocker: dockerMocks.execDocker,
    readDockerContainerEnvVar: dockerMocks.readDockerContainerEnvVar,
    readDockerContainerLabel: dockerMocks.readDockerContainerLabel,
    readDockerNetworkDriver: dockerMocks.readDockerNetworkDriver,
    readDockerNetworkGateway: dockerMocks.readDockerNetworkGateway,
    readDockerPort: dockerMocks.readDockerPort,
  };
});

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  updateBrowserRegistry: registryMocks.updateBrowserRegistry,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  startBrowserBridgeServer: bridgeMocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

vi.mock("../../plugin-sdk/browser-profiles.js", () => ({
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS: 60_000,
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  DEFAULT_OPENCLAW_BROWSER_COLOR: "#FF4500",
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: "openclaw",
  resolveProfile: (
    resolved: { cdpHost: string; cdpIsLoopback: boolean; profiles?: Record<string, unknown> },
    profileName: string,
  ) => {
    const profile = resolved.profiles?.[profileName] as { cdpPort?: number; color?: string };
    if (typeof profile?.cdpPort !== "number") {
      return null;
    }
    return {
      name: profileName,
      cdpPort: profile.cdpPort,
      cdpUrl: `http://${resolved.cdpHost}:${profile.cdpPort}`,
      cdpHost: resolved.cdpHost,
      cdpIsLoopback: resolved.cdpIsLoopback,
      color: profile.color ?? "#FF4500",
      driver: "openclaw",
      attachOnly: true,
    };
  },
}));

async function loadFreshBrowserModulesForTest() {
  vi.resetModules();
  ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
  ({ ensureSandboxBrowser } = await import("./browser.js"));
  ({ resetNoVncObserverTokensForTests } = await import("./novnc-auth.js"));
}

function buildConfig(enableNoVnc: boolean): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      enableNoVnc,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
  };
}

type EnsureSandboxBrowserParams = Parameters<typeof import("./browser.js").ensureSandboxBrowser>[0];

async function ensureTestSandboxBrowser(params: Omit<EnsureSandboxBrowserParams, "bridgeAuth">) {
  return await ensureSandboxBrowser({
    ...params,
    bridgeAuth: { token: "test-bridge-token" },
  });
}

function requireDockerCreateArgs(): string[] {
  const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
  if (!createArgs) {
    throw new Error("expected docker create args");
  }
  return createArgs;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function latestBridgeResolved(): Record<string, unknown> {
  const params = bridgeMocks.startBrowserBridgeServer.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("expected browser bridge start params");
  }
  const resolved = params.resolved;
  if (!resolved || typeof resolved !== "object") {
    throw new Error("expected resolved browser bridge config");
  }
  return resolved;
}

describe("ensureSandboxBrowser create args", () => {
  beforeAll(async () => {
    await loadFreshBrowserModulesForTest();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    BROWSER_BRIDGES.clear();
    resetNoVncObserverTokensForTests();
    dockerMocks.dockerContainerState.mockClear();
    dockerMocks.execDocker.mockClear();
    dockerMocks.readDockerContainerEnvVar.mockClear();
    dockerMocks.readDockerContainerLabel.mockClear();
    dockerMocks.readDockerNetworkDriver.mockClear();
    dockerMocks.readDockerNetworkGateway.mockClear();
    dockerMocks.readDockerPort.mockClear();
    registryMocks.readBrowserRegistry.mockClear();
    registryMocks.updateBrowserRegistry.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockClear();
    bridgeMocks.stopBrowserBridgeServer.mockClear();

    dockerMocks.dockerContainerState.mockResolvedValue({ exists: false, running: false });
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    dockerMocks.readDockerContainerLabel.mockResolvedValue(null);
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    dockerMocks.readDockerNetworkDriver.mockResolvedValue("bridge");
    dockerMocks.readDockerNetworkGateway.mockResolvedValue("172.21.0.1");
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return 49100;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue({
      server: {} as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        server: null,
        port: 19000,
        resolved: { profiles: {} },
        profiles: new Map(),
      },
    });
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("publishes noVNC on loopback and injects noVNC password env", async () => {
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(true),
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs).toContain("127.0.0.1::6080");
    const envEntries = collectDockerFlagValues(createArgs, "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const passwordEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
    );
    expect(passwordEntry).toMatch(/^OPENCLAW_BROWSER_NOVNC_PASSWORD=[A-Za-z0-9]{8}$/);
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
  });

  it("does not inject noVNC password env when noVNC is disabled", async () => {
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(
      envEntries.filter((entry) => entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD=")),
    ).toStrictEqual([]);
    expect(result?.noVncUrl).toBeUndefined();
  });

  it("fails before creating a browser container when Docker daemon is unavailable", async () => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          stdout: "",
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          code: 1,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("Docker daemon is not available");

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
  });

  it("passes the browser SSRF policy to the sandbox bridge", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
  });

  it("recreates a cached bridge when the SSRF policy changes", async () => {
    const existingBridge = {
      server: {} as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };
    BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      ssrfPolicy: { allowedHostnames: ["example.com"] },
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      allowedHostnames: ["example.com"],
    });
  });

  it("recreates a cached bridge when evaluate permission changes", async () => {
    const existingBridge = {
      server: {} as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
        },
      },
    };
    BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      evaluateEnabled: false,
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().evaluateEnabled).toBe(false);
  });

  it("mounts the main workspace read-only when workspaceAccess is none", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "none";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs).toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("keeps the main workspace writable when workspaceAccess is rw", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs).toContain("/tmp/workspace:/workspace:z");
    expect(createArgs).not.toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("stamps the mount format version label on browser containers", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const labels = collectDockerFlagValues(createArgs ?? [], "--label");
    expect(labels).toContain(`openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  });

  it("force-removes the browser container when CDP never becomes reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      return {
        server: {} as never,
        port: 19000,
        baseUrl: "http://127.0.0.1:19000",
        state: {
          server: null,
          port: 19000,
          resolved: { profiles: {} },
          profiles: new Map(),
        },
      };
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 1;

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow("hung container has been forcefully removed");

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
  });

  it("auto-derives CDP source range from Docker network gateway", async () => {
    dockerMocks.readDockerNetworkGateway.mockResolvedValue("172.21.0.1");

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=172.21.0.1/32");
  });

  it("uses explicit cdpSourceRange over auto-derived gateway", async () => {
    dockerMocks.readDockerNetworkGateway.mockResolvedValue("172.21.0.1");
    const cfg = buildConfig(false);
    cfg.browser.cdpSourceRange = "10.0.0.0/24";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=10.0.0.0/24");
    expect(dockerMocks.readDockerNetworkGateway).not.toHaveBeenCalled();
  });

  it("rejects IPv6-only gateway (relay binds IPv4)", async () => {
    dockerMocks.readDockerNetworkGateway.mockResolvedValue("fd12::1");

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow(/Cannot derive CDP source range/);
  });

  it("throws when CDP source range cannot be derived", async () => {
    dockerMocks.readDockerNetworkGateway.mockResolvedValue(null);

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow(/Cannot derive CDP source range/);
  });

  it("requires explicit cdpSourceRange for non-bridge network drivers", async () => {
    dockerMocks.readDockerNetworkDriver.mockResolvedValue("macvlan");
    dockerMocks.readDockerNetworkGateway.mockResolvedValue("172.21.0.1");

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow(/Cannot derive CDP source range/);
    // Gateway helper should not have been called for non-bridge networks.
    expect(dockerMocks.readDockerNetworkGateway).not.toHaveBeenCalled();
  });

  it("uses loopback range for network=none (no IPAM gateway, no peer risk)", async () => {
    dockerMocks.readDockerNetworkGateway.mockResolvedValue(null);
    const cfg = buildConfig(false);
    cfg.browser.network = "none";

    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    requireValue(result, "sandbox browser result");
    const createArgs = requireDockerCreateArgs();
    const envEntries = collectDockerFlagValues(createArgs, "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=127.0.0.1/32");
  });
});
