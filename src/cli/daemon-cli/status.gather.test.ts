// Daemon status gather tests cover service status collection from platform state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import type { PortListener, PortUsageStatus } from "../../infra/ports.js";
import type { GatewayRestartHandoff } from "../../infra/restart-handoff.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import type { GatewayRestartSnapshot } from "./restart-health.js";
import { gatherDaemonStatus } from "./status.gather.js";

type PortConnections = Awaited<
  ReturnType<typeof import("../../infra/ports.js").inspectPortConnections>
>;

const callGatewayStatusProbe = vi.fn<
  (opts?: unknown) => Promise<{
    ok: boolean;
    url?: string;
    error?: string | null;
    server?: { version?: string | null; connId?: string | null };
    version?: string | null;
  }>
>(async (_opts?: unknown) => ({
  ok: true,
  url: "ws://127.0.0.1:19001",
  error: null,
  server: { version: "2026.5.6", connId: "conn-1" },
}));
const resolveGatewayProbeAuthSafeWithSecretInputsCalls = vi.fn<(opts?: unknown) => void>();
const loadGatewayTlsRuntime = vi.fn(async (_cfg?: unknown) => ({
  enabled: true,
  required: true,
  fingerprintSha256: "sha256:11:22:33:44",
}));
const findExtraGatewayServices = vi.fn(async (_env?: unknown, _opts?: unknown) => []);
const findStaleOpenClawUpdateLaunchdJobs = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<StaleOpenClawUpdateLaunchdJob[]>
>(async () => []);
type PortUsageTestSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

const inspectPortUsage = vi.fn<(port: number) => Promise<PortUsageTestSummary>>(
  async (port: number) => ({
    port,
    status: "free",
    listeners: [],
    hints: [],
  }),
);
const inspectPortConnections = vi.fn<(port: number) => Promise<PortConnections>>(
  async (port: number) => ({
    port,
    connections: [],
  }),
);
const readLastGatewayErrorLine = vi.fn<
  (_env?: NodeJS.ProcessEnv, _options?: { requirePatternMatch?: boolean }) => Promise<string | null>
>(async (_env?: NodeJS.ProcessEnv, _options?: { requirePatternMatch?: boolean }) => null);
const loadInstalledPluginIndexInstallRecords = vi.fn<
  (params?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
  }) => Promise<Record<string, unknown>>
>(async (_params?) => ({}));
const readGatewayRestartHandoffSync = vi.fn<
  (_env?: NodeJS.ProcessEnv) => GatewayRestartHandoff | null
>(() => null);
const inspectWindowsGatewayFirewall = vi.fn<(opts?: unknown) => Promise<unknown>>(async () => ({
  applies: false,
  severity: "info" as const,
  code: "windows_firewall_not_applicable",
  message: "Windows LAN firewall diagnostics do not apply.",
  details: [],
}));
const auditGatewayServiceConfig = vi.fn(async (_opts?: unknown) => undefined);
const serviceIsLoaded = vi.fn(async (_opts?: unknown) => true);
const serviceReadRuntime = vi.fn<
  (_env?: NodeJS.ProcessEnv) => Promise<{ status: string; detail?: string }>
>(async (_env?: NodeJS.ProcessEnv) => ({ status: "running" }));
const inspectGatewayRestart = vi.fn<(opts?: unknown) => Promise<GatewayRestartSnapshot>>(
  async (_opts?: unknown) => ({
    runtime: { status: "running", pid: 1234 },
    portUsage: { port: 19001, status: "busy", listeners: [], hints: [] },
    healthy: true,
    staleGatewayPids: [],
  }),
);
const serviceReadCommand = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<{
    programArguments: string[];
    environment?: Record<string, string>;
  } | null>
>(async (_env?: NodeJS.ProcessEnv) => ({
  programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
  environment: {
    OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
    OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
  },
}));
const resolveGatewayBindHost = vi.fn(
  async (_bindMode?: string, _customBindHost?: string) => "0.0.0.0",
);
const resolveAdvertisedControlUiLinks = vi.fn(async (_opts?: unknown) => ({
  httpUrl: "https://10.211.55.3:19001/",
  wsUrl: "wss://10.211.55.3:19001",
}));
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const resolveGatewayPort = vi.fn((_cfg?: unknown, _env?: unknown) => 18789);
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli",
);
const resolveConfigPath = vi.fn((env: NodeJS.ProcessEnv, stateDir: string) => {
  return env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`;
});
const createConfigIOCalls = vi.fn((configPath: string, pluginValidation?: "full" | "skip") => ({
  configPath,
  pluginValidation,
}));
const readConfigFileSnapshotCalls = vi.fn((configPath: string) => configPath);
const loadConfigCalls = vi.fn((configPath: string) => configPath);
let daemonConfigWarnings: Array<{ path: string; message: string }> = [];
let cliConfigWarnings: Array<{ path: string; message: string }> = [];
let daemonLoadedConfig: Record<string, unknown> = {
  gateway: {
    bind: "lan",
    tls: { enabled: true },
    auth: { token: "daemon-token" },
  },
};
let cliLoadedConfig: Record<string, unknown> = {
  gateway: {
    bind: "loopback",
  },
};

vi.mock("../../config/config.js", () => ({
  createConfigIO: ({
    configPath,
    pluginValidation,
  }: {
    configPath: string;
    pluginValidation?: "full" | "skip";
  }) => {
    const isDaemon = configPath.includes("/openclaw-daemon/");
    const runtimeConfig = isDaemon ? daemonLoadedConfig : cliLoadedConfig;
    const warnings = isDaemon ? daemonConfigWarnings : cliConfigWarnings;
    createConfigIOCalls(configPath, pluginValidation);
    return {
      readConfigFileSnapshot: async () => {
        readConfigFileSnapshotCalls(configPath);
        return {
          path: configPath,
          exists: true,
          valid: true,
          issues: [],
          warnings: pluginValidation === "full" ? warnings : [],
          runtimeConfig,
          config: runtimeConfig,
        };
      },
      loadConfig: () => {
        loadConfigCalls(configPath);
        return runtimeConfig;
      },
    };
  },
  getRuntimeConfig: () => cliLoadedConfig,
  loadConfig: () => cliLoadedConfig,
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
  resolveStateDir: (env: NodeJS.ProcessEnv) => resolveStateDir(env),
}));

vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: (env: NodeJS.ProcessEnv, options?: { requirePatternMatch?: boolean }) =>
    readLastGatewayErrorLine(env, options),
}));

vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
}));

vi.mock("../../daemon/launchd.js", () => ({
  findStaleOpenClawUpdateLaunchdJobs: (env?: NodeJS.ProcessEnv) =>
    findStaleOpenClawUpdateLaunchdJobs(env),
}));

vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: (opts: unknown) => auditGatewayServiceConfig(opts),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () =>
    createMockGatewayService({
      isLoaded: serviceIsLoaded,
      readCommand: serviceReadCommand,
      readRuntime: serviceReadRuntime,
    }),
}));

vi.mock("../../gateway/net.js", () => ({
  resolveGatewayBindHost: (bindMode: string, customBindHost?: string) =>
    resolveGatewayBindHost(bindMode, customBindHost),
}));

vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveAdvertisedControlUiLinks: (opts?: unknown) => resolveAdvertisedControlUiLinks(opts),
}));

vi.mock("../../gateway/probe-auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGatewayProbeAuthSafeWithSecretInputs: async (opts: unknown) => {
      resolveGatewayProbeAuthSafeWithSecretInputsCalls(opts);
      return await (
        actual.resolveGatewayProbeAuthSafeWithSecretInputs as (opts: unknown) => Promise<unknown>
      )(opts);
    },
  };
});

vi.mock("../../infra/ports.js", () => ({
  inspectPortConnections: (port: number) => inspectPortConnections(port),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: () => [],
}));

vi.mock("../../infra/restart-handoff.js", () => ({
  readGatewayRestartHandoffSync: (env?: NodeJS.ProcessEnv) => readGatewayRestartHandoffSync(env),
}));

vi.mock("../../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (cfg: unknown) => loadGatewayTlsRuntime(cfg),
}));

vi.mock("../../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: (opts: unknown) => inspectWindowsGatewayFirewall(opts),
}));

vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => callGatewayStatusProbe(opts),
}));

vi.mock("../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords: (params?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
  }) => loadInstalledPluginIndexInstallRecords(params),
}));

vi.mock("./restart-health.js", () => ({
  inspectGatewayRestart: (opts: unknown) => inspectGatewayRestart(opts),
}));

function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

describe("gatherDaemonStatus", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "DAEMON_GATEWAY_TOKEN",
      "DAEMON_GATEWAY_PASSWORD",
    ]);
    setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-cli");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", "/tmp/openclaw-cli/openclaw.json");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    deleteTestEnvValue("DAEMON_GATEWAY_TOKEN");
    deleteTestEnvValue("DAEMON_GATEWAY_PASSWORD");
    callGatewayStatusProbe.mockClear();
    resolveAdvertisedControlUiLinks.mockClear();
    resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: "https://10.211.55.3:19001/",
      wsUrl: "wss://10.211.55.3:19001",
    });
    resolveGatewayProbeAuthSafeWithSecretInputsCalls.mockClear();
    createConfigIOCalls.mockClear();
    findStaleOpenClawUpdateLaunchdJobs.mockReset();
    findStaleOpenClawUpdateLaunchdJobs.mockResolvedValue([]);
    loadInstalledPluginIndexInstallRecords.mockClear();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    loadGatewayTlsRuntime.mockClear();
    inspectGatewayRestart.mockClear();
    inspectPortUsage.mockReset();
    inspectPortUsage.mockImplementation(async (port: number) => ({
      port,
      status: "free" as const,
      listeners: [],
      hints: [],
    }));
    inspectPortConnections.mockClear();
    inspectWindowsGatewayFirewall.mockClear();
    inspectWindowsGatewayFirewall.mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    readLastGatewayErrorLine.mockReset();
    readLastGatewayErrorLine.mockResolvedValue(null);
    readGatewayRestartHandoffSync.mockClear();
    readConfigFileSnapshotCalls.mockClear();
    loadConfigCalls.mockClear();
    daemonConfigWarnings = [];
    cliConfigWarnings = [];
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: { token: "daemon-token" },
      },
    };
    cliLoadedConfig = {
      gateway: {
        bind: "loopback",
      },
    };
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses wss probe URL and forwards TLS fingerprint when daemon TLS is enabled", async () => {
    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).toHaveBeenCalledTimes(1);
    const probeInput = callArg(callGatewayStatusProbe) as {
      url?: string;
      tlsFingerprint?: string;
      token?: string;
    };
    expect(probeInput.url).toBe("wss://127.0.0.1:19001");
    expect(probeInput.tlsFingerprint).toBe("sha256:11:22:33:44");
    expect(probeInput.token).toBe("daemon-token");
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.gateway?.controlUiLinks).toEqual({
      httpUrl: "https://10.211.55.3:19001/",
      wsUrl: "wss://10.211.55.3:19001",
    });
    expect(status.gateway?.tlsEnabled).toBe(true);
    expect(status.gateway?.version).toBe("2026.5.6");
    expect(status.rpc?.url).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.ok).toBe(true);
    expect(status.rpc?.server).toEqual({ version: "2026.5.6", connId: "conn-1" });
    expect(status.cli?.version).toBe(VERSION);
    if (process.argv[1]) {
      expect(status.cli?.entrypoint).toBe(process.argv[1]);
    }
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
  });

  it("reports the heap limit from the installed Gateway service", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
        NODE_OPTIONS: "--max-old-space-size=6144",
      },
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(status.service.gatewayHeap).toMatchObject({ appliedMiB: 6144 });
    expect(status.service.gatewayHeap?.memorySource).toMatch(/^(constrained|physical)$/u);
  });

  it("includes Windows firewall diagnostics during deep LAN gateway status", async () => {
    inspectWindowsGatewayFirewall.mockResolvedValueOnce({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
      message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
      details: ["Windows reports LocalFirewallRules as N/A (GPO-store only)."],
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: true,
    });

    expect(inspectWindowsGatewayFirewall).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", mode: "quick", port: 19001 }),
    );
    expect(status.gateway?.windowsFirewall).toMatchObject({
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
  });

  it("falls back to probe version when server metadata is unavailable", async () => {
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:19001",
      error: null,
      version: "2026.5.7",
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(status.gateway?.version).toBe("2026.5.7");
    expect(status.rpc?.version).toBe("2026.5.7");
    expect(status.rpc?.server).toBeUndefined();
  });

  it("forwards requireRpc and configPath to the daemon probe", async () => {
    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      requireRpc: true,
      deep: false,
    });

    const probeInput = callArg(callGatewayStatusProbe) as {
      requireRpc?: boolean;
      configPath?: string;
    };
    expect(probeInput.requireRpc).toBe(true);
    expect(probeInput.configPath).toBe("/tmp/openclaw-daemon/openclaw.json");
  });

  it("reuses the shared CLI config snapshot when the daemon uses the same config path", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    });

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(readConfigFileSnapshotCalls).toHaveBeenCalledTimes(1);
    expect(readConfigFileSnapshotCalls).toHaveBeenCalledWith("/tmp/openclaw-cli/openclaw.json");
    expect(loadConfigCalls).not.toHaveBeenCalled();
  });

  it("defaults unset daemon bind mode to loopback for host-side status reporting", async () => {
    daemonLoadedConfig = {
      gateway: {
        tls: { enabled: true },
        auth: { token: "daemon-token" },
      },
    };

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(status.gateway?.bindMode).toBe("loopback");
  });

  it("does not force local TLS fingerprint when probe URL is explicitly overridden", async () => {
    const status = await gatherDaemonStatus({
      rpc: { url: "wss://override.example:18790" },
      probe: true,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    const probeInput = callArg(callGatewayStatusProbe) as {
      url?: string;
      tlsFingerprint?: string;
    };
    expect(probeInput.url).toBe("wss://override.example:18790");
    expect(probeInput.tlsFingerprint).toBeUndefined();
    expect(status.gateway?.probeUrl).toBe("wss://override.example:18790");
    expect(status.rpc?.url).toBe("wss://override.example:18790");
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(status.pluginVersionDrift).toBeUndefined();
  });

  it("uses fallback network details when interface discovery throws during status inspection", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "tailnet",
        tls: { enabled: true },
        auth: { token: "daemon-token" },
      },
    };
    resolveGatewayBindHost.mockImplementationOnce(async () => {
      throw new Error("uv_interface_addresses failed");
    });
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(status.gateway?.bindMode).toBe("tailnet");
    expect(status.gateway?.bindHost).toBe("127.0.0.1");
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.gateway?.probeNote).toContain("interface discovery failed");
    expect(status.gateway?.probeNote).toContain("tailnet addresses");
  });

  it("reuses command environment when reading runtime status", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
      environment: {
        OPENCLAW_GATEWAY_PORT: "19001",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      } as Record<string, string>,
    });
    serviceReadRuntime.mockImplementationOnce(async (env?: NodeJS.ProcessEnv) => ({
      status: env?.OPENCLAW_GATEWAY_PORT === "19001" ? "running" : "unknown",
      detail: env?.OPENCLAW_GATEWAY_PORT ?? "missing-port",
    }));

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(
      serviceReadRuntime.mock.calls.some(([env]) => env?.OPENCLAW_GATEWAY_PORT === "19001"),
    ).toBe(true);
    expect(status.service.runtime?.status).toBe("running");
    expect((status.service.runtime as { detail?: string }).detail).toBe("19001");
  });

  it("keeps gateway status read-only when service management is unsupported", async () => {
    serviceReadCommand.mockResolvedValueOnce(null);
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceReadRuntime.mockResolvedValueOnce({
      status: "unknown",
      detail: "Gateway service install not supported on aix",
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(status.service.command).toBeNull();
    expect(status.service.loaded).toBe(false);
    expect(status.service.runtime).toEqual({
      status: "unknown",
      detail: "Gateway service install not supported on aix",
    });
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
  });

  it("surfaces recent service restart handoffs only during deep status", async () => {
    readGatewayRestartHandoffSync.mockReturnValueOnce({
      kind: "gateway-supervisor-restart-handoff",
      version: 1,
      intentId: "intent-1",
      pid: 12_345,
      createdAt: 10_000,
      expiresAt: 70_000,
      reason: "plugin source changed",
      source: "plugin-change",
      restartKind: "full-process",
      supervisorMode: "launchd",
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: true,
    });

    const handoffInput = callArg(readGatewayRestartHandoffSync) as NodeJS.ProcessEnv;
    expect(handoffInput.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-daemon");
    expect(handoffInput.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-daemon/openclaw.json");
    expect(status.service.restartHandoff?.reason).toBe("plugin source changed");
    expect(status.service.restartHandoff?.restartKind).toBe("full-process");
    expect(status.service.restartHandoff?.supervisorMode).toBe("launchd");
  });

  it.runIf(process.platform === "darwin")(
    "surfaces stale updater launchd jobs only during deep status",
    async () => {
      serviceReadCommand.mockResolvedValueOnce({
        programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
        environment: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
          OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
        },
      });
      findStaleOpenClawUpdateLaunchdJobs.mockResolvedValueOnce([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
        {
          label: "ai.openclaw.manual-update.1717168800",
          lastExitStatus: 0,
        },
      ]);

      const status = await gatherDaemonStatus({
        rpc: {},
        probe: false,
        deep: true,
      });

      const staleScanEnv = findStaleOpenClawUpdateLaunchdJobs.mock.calls[0]?.[0];
      expect(staleScanEnv?.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-daemon");
      expect(staleScanEnv?.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-daemon/openclaw.json");
      expect(staleScanEnv?.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.manual-update.gateway");
      expect(status.service.staleUpdateLaunchdJobs).toEqual([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
        {
          label: "ai.openclaw.manual-update.1717168800",
          lastExitStatus: 0,
        },
      ]);
    },
  );

  it("does not read restart handoffs during normal status", async () => {
    await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(readGatewayRestartHandoffSync).not.toHaveBeenCalled();
    expect(findStaleOpenClawUpdateLaunchdJobs).not.toHaveBeenCalled();
    expect(inspectPortConnections).not.toHaveBeenCalled();
  });

  it("surfaces established gateway connections during deep status", async () => {
    inspectPortConnections.mockResolvedValueOnce({
      port: 19001,
      connections: [
        {
          pid: 4242,
          ppid: 1,
          command: "node",
          commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
          address: "TCP 127.0.0.1:50123->127.0.0.1:19001 (ESTABLISHED)",
          direction: "client",
        },
      ],
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: true,
    });

    expect(inspectPortConnections).toHaveBeenCalledWith(19001);
    expect(status.connections?.established).toEqual([
      {
        pid: 4242,
        ppid: 1,
        command: "node",
        commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
        address: "TCP 127.0.0.1:50123->127.0.0.1:19001 (ESTABLISHED)",
        direction: "client",
      },
    ]);
  });

  it("skips established gateway connection scans for remote gateway status", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        bind: "lan",
        remote: { url: "wss://gateway.example" },
      },
    };

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: true,
    });

    expect(inspectPortConnections).not.toHaveBeenCalled();
    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(status.connections).toBeUndefined();
    expect(status.pluginVersionDrift).toBeUndefined();
  });

  it("uses the fast config path for plain same-file status reads", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-status-config-"));
    const configPath = path.join(tmp, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          bind: "custom",
          customBindHost: "10.0.0.5",
          controlUi: { enabled: true },
        },
      }),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tmp);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
      environment: {
        OPENCLAW_STATE_DIR: tmp,
        OPENCLAW_CONFIG_PATH: configPath,
      },
    });

    try {
      const status = await gatherDaemonStatus({
        rpc: {},
        probe: false,
        deep: false,
      });

      expect(readConfigFileSnapshotCalls).not.toHaveBeenCalled();
      expect(loadConfigCalls).not.toHaveBeenCalled();
      expect(status.config?.cli.path).toBe(configPath);
      expect(status.config?.cli.exists).toBe(true);
      expect(status.config?.cli.valid).toBe(true);
      expect(status.config?.cli.controlUi).toEqual({ enabled: true });
      expect(status.config?.daemon).toBe(status.config?.cli);
      expect(status.gateway?.bindMode).toBe("custom");
      expect(status.gateway?.customBindHost).toBe("10.0.0.5");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("uses full plugin-aware config validation for deep status", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-status-config-"));
    const configPath = path.join(tmp, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          bind: "loopback",
        },
      }),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tmp);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    cliLoadedConfig = {
      gateway: {
        bind: "loopback",
      },
    };
    cliConfigWarnings = [
      {
        path: "plugins.entries.test-bad-plugin",
        message:
          "plugin test-bad-plugin: channel plugin manifest declares test-bad-plugin without channelConfigs metadata",
      },
    ];
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    });

    try {
      const status = await gatherDaemonStatus({
        rpc: {},
        probe: false,
        deep: true,
      });

      expect(createConfigIOCalls).toHaveBeenCalledWith(configPath, "full");
      expect(readConfigFileSnapshotCalls).toHaveBeenCalledWith(configPath);
      expect(status.config?.cli.warnings).toEqual(cliConfigWarnings);
      expect(status.config?.daemon).toBe(status.config?.cli);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves daemon gateway auth password SecretRef values before probing", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          password: { source: "env", provider: "default", id: "DAEMON_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    setTestEnvValue("DAEMON_GATEWAY_PASSWORD", "daemon-secretref-password"); // pragma: allowlist secret

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect((callArg(callGatewayStatusProbe) as { password?: string }).password).toBe(
      "daemon-secretref-password",
    ); // pragma: allowlist secret
  });

  it("resolves daemon gateway auth token SecretRef values before probing", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: "${DAEMON_GATEWAY_TOKEN}",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    setTestEnvValue("DAEMON_GATEWAY_TOKEN", "daemon-secretref-token");

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect((callArg(callGatewayStatusProbe) as { token?: string }).token).toBe(
      "daemon-secretref-token",
    );
  });

  it("skips daemon exec SecretRef probe auth when exec refs are disabled", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
      allowExecSecretRefs: false,
    });

    expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).not.toHaveBeenCalled();
    const probeInput = callArg(callGatewayStatusProbe) as {
      token?: string;
      password?: string;
      allowRpcConfigCredentials?: boolean;
    };
    expect(probeInput.token).toBeUndefined();
    expect(probeInput.password).toBeUndefined();
    expect(probeInput.allowRpcConfigCredentials).toBe(false);
    expect(status.rpc?.authWarning).toContain(
      "gateway credentials use an exec SecretRef and exec SecretRefs are disabled",
    );
  });

  it("ignores remote exec SecretRefs for local probes when exec refs are disabled", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        tls: { enabled: true },
        auth: { token: "daemon-token" },
        remote: {
          url: "wss://gateway.example",
          token: { source: "exec", provider: "vault", id: "gateway/remote-token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
      allowExecSecretRefs: false,
    });

    expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).toHaveBeenCalledTimes(1);
    const probeInput = callArg(callGatewayStatusProbe) as { token?: string; password?: string };
    expect(probeInput.token).toBe("daemon-token");
    expect(probeInput.password).toBeUndefined();
  });

  it("ignores local exec SecretRefs for remote probes when exec refs are disabled", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
      allowExecSecretRefs: false,
    });

    expect(status.rpc?.authWarning).toBeUndefined();
    expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).toHaveBeenCalledTimes(1);
    const probeInput = callArg(callGatewayStatusProbe) as { token?: string; password?: string };
    expect(probeInput.token).toBeUndefined();
    expect(probeInput.password).toBeUndefined();
  });

  it("does not resolve daemon password SecretRef when token auth is configured", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: "daemon-token",
          password: { source: "env", provider: "default", id: "MISSING_DAEMON_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    const probeInput = callArg(callGatewayStatusProbe) as { token?: string; password?: string };
    expect(probeInput.token).toBe("daemon-token");
    expect(probeInput.password).toBeUndefined();
  });

  it("degrades safely when daemon probe auth SecretRef is unresolved", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_DAEMON_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    const probeInput = callArg(callGatewayStatusProbe) as { token?: string; password?: string };
    expect(probeInput.token).toBeUndefined();
    expect(probeInput.password).toBeUndefined();
    expect(status.rpc?.authWarning).toBeUndefined();
  });

  it("surfaces authWarning when daemon probe auth SecretRef is unresolved and probe fails", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_DAEMON_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      error: "gateway closed",
      url: "wss://127.0.0.1:19001",
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(status.rpc?.ok).toBe(false);
    expect(status.rpc?.authWarning).toContain(
      "gateway.auth.token SecretRef is unresolved in this command path",
    );
    expect(status.rpc?.authWarning).toContain("probing without configured auth credentials");
  });

  it("keeps remote probe auth strict when remote token is missing", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          password: "remote-password", // pragma: allowlist secret
        },
        auth: {
          mode: "token",
          token: "local-token",
          password: "local-password", // pragma: allowlist secret
        },
      },
    };
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "env-token");
    setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", "env-password"); // pragma: allowlist secret

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    const probeInput = callArg(callGatewayStatusProbe) as { token?: string; password?: string };
    expect(probeInput.token).toBeUndefined();
    expect(probeInput.password).toBe("env-password"); // pragma: allowlist secret
  });

  it("skips TLS runtime loading when probe is disabled", async () => {
    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).not.toHaveBeenCalled();
    expect(status.rpc).toBeUndefined();
  });

  it("surfaces stale gateway listener pids from restart health inspection when probe fails", async () => {
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:19001",
      error: "timeout",
    });
    inspectGatewayRestart.mockResolvedValueOnce({
      runtime: { status: "running", pid: 8000 },
      portUsage: {
        port: 19001,
        status: "busy",
        listeners: [{ pid: 9000, ppid: 8999, commandLine: "openclaw-gateway" }],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [9000],
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect((callArg(inspectGatewayRestart) as { port?: number }).port).toBe(19001);
    expect(status.health).toEqual({
      healthy: false,
      staleGatewayPids: [9000],
    });
  });

  it("includes the last gateway error when the service is listening but the RPC probe fails", async () => {
    inspectPortUsage.mockResolvedValueOnce({
      port: 19001,
      status: "busy",
      listeners: [{ pid: 8000, ppid: 1, commandLine: "openclaw gateway" }],
      hints: [],
    });
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "wss://127.0.0.1:19001",
      error: "gateway closed (1000): ",
    });
    readLastGatewayErrorLine.mockResolvedValueOnce(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(readLastGatewayErrorLine).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
      }),
      { requirePatternMatch: true },
    );
    expect(status.port?.status).toBe("busy");
    expect(status.rpc?.ok).toBe(false);
    expect(status.lastError).toBe(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );
  });

  it("does not read local gateway errors for an explicit probe URL", async () => {
    inspectPortUsage.mockResolvedValueOnce({
      port: 19001,
      status: "busy",
      listeners: [{ pid: 8000, ppid: 1, commandLine: "openclaw gateway" }],
      hints: [],
    });
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "wss://remote.example:18790",
      error: "gateway closed (1000): ",
    });

    const status = await gatherDaemonStatus({
      rpc: { url: "wss://remote.example:18790" },
      probe: true,
      deep: false,
    });

    expect(readLastGatewayErrorLine).not.toHaveBeenCalled();
    expect(status.lastError).toBeUndefined();
  });

  it("does not read local gateway errors in remote mode", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example:18790" },
        auth: { token: "daemon-token" },
      },
    };
    inspectPortUsage.mockResolvedValueOnce({
      port: 19001,
      status: "busy",
      listeners: [{ pid: 8000, ppid: 1, commandLine: "openclaw gateway" }],
      hints: [],
    });
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "wss://remote.example:18790",
      error: "gateway closed (1000): ",
    });

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(readLastGatewayErrorLine).not.toHaveBeenCalled();
    expect(status.lastError).toBeUndefined();
  });

  it("compares plugin drift against the running gateway version from the probe, not the CLI VERSION", async () => {
    // Gateway is still running an older version than the invoking CLI.
    // An npm plugin pinned to the running gateway version must NOT be
    // reported as drifted just because the CLI package is newer.
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:19001",
      error: null,
      server: { version: "2026.5.4", connId: "c1" },
    } as never);
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.4",
      },
    } as never);

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: true,
    });

    expect(status.pluginVersionDrift?.gatewayVersion).toBe("2026.5.4");
    expect(status.pluginVersionDrift?.drifts).toEqual([]);
  });

  it("flags drift against the running gateway version when an npm plugin lags behind it", async () => {
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:19001",
      error: null,
      server: { version: "2026.5.4", connId: "c1" },
    } as never);
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.3",
      },
    } as never);

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: true,
    });

    expect(status.pluginVersionDrift?.gatewayVersion).toBe("2026.5.4");
    expect(status.pluginVersionDrift?.drifts.map((d) => d.pluginId)).toEqual(["whatsapp"]);
  });

  it("reads install records from the merged daemon service environment, not the CLI process env", async () => {
    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: true,
    });

    // The mock daemon service command sets OPENCLAW_STATE_DIR=/tmp/openclaw-daemon,
    // distinct from the CLI process OPENCLAW_STATE_DIR=/tmp/openclaw-cli. Drift
    // detection must inspect the daemon profile's install records.
    expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        }),
      }),
    );
  });

  it("reads install records and computes drift outside deep mode", async () => {
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.3",
      },
    } as never);

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        }),
      }),
    );
    expect(status.pluginVersionDrift?.drifts.map((d) => d.pluginId)).toEqual(["whatsapp"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
