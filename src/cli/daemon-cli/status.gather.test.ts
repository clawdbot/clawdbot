import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import type { GatewayRestartHandoff } from "../../infra/restart-handoff.js";
import { captureEnv } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import type { GatewayRestartSnapshot } from "./restart-health.js";
import { gatherDaemonStatus } from "./status.gather.js";

const callGatewayStatusProbe = vi.fn<
  (opts?: unknown) => Promise<{
    ok: boolean;
    url?: string;
    error?: string | null;
    server?: { version?: string | null; connId?: string | null };
  }>
>(async (_opts?: unknown) => ({
  ok: true,
  url: "ws://127.0.0.1:19001",
  error: null,
  server: { version: "2026.5.6", connId: "conn-1" },
}));
const loadGatewayTlsRuntime = vi.fn(async (_cfg?: unknown) => ({
  enabled: true,
  required: true,
  fingerprintSha256: "sha256:11:22:33:44",
}));
const findExtraGatewayServices = vi.fn(async (_env?: unknown, _opts?: unknown) => []);
const findStaleOpenClawUpdateLaunchdJobs = vi.fn<() => Promise<StaleOpenClawUpdateLaunchdJob[]>>(
  async () => [],
);
const inspectPortUsage = vi.fn(async (port: number) => ({
  port,
  status: "free" as const,
  listeners: [],
  hints: [],
}));
const readLastGatewayErrorLine = vi.fn(async (_env?: NodeJS.ProcessEnv) => null);
const readGatewayRestartHandoffSync = vi.fn<
  (_env?: NodeJS.ProcessEnv) => GatewayRestartHandoff | null
>(() => null);
const auditGatewayServiceConfig = vi.fn(async (_opts?: unknown) => undefined);
const serviceIsLoaded = vi.fn(async (_opts?: unknown) => true);
const serviceReadRuntime = vi.fn(async (_env?: NodeJS.ProcessEnv) => ({ status: "running" }));
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
  }>
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
  readLastGatewayErrorLine: (env: NodeJS.ProcessEnv) => readLastGatewayErrorLine(env),
}));

vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
}));

vi.mock("../../daemon/launchd.js", () => ({
  findStaleOpenClawUpdateLaunchdJobs: () => findStaleOpenClawUpdateLaunchdJobs(),
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

vi.mock("../../infra/ports.js", () => ({
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

vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => callGatewayStatusProbe(opts),
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
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-cli";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-cli/openclaw.json";
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.DAEMON_GATEWAY_TOKEN;
    delete process.env.DAEMON_GATEWAY_PASSWORD;
    callGatewayStatusProbe.mockClear();
    createConfigIOCalls.mockClear();
    findStaleOpenClawUpdateLaunchdJobs.mockReset();
    findStaleOpenClawUpdateLaunchdJobs.mockResolvedValue([]);
    loadGatewayTlsRuntime.mockClear();
    inspectGatewayRestart.mockClear();
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
    expect(status.gateway?.tlsEnabled).toBe(true);
    expect(status.rpc?.url).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.ok).toBe(true);
    expect(status.rpc?.server).toEqual({ version: "2026.5.6", connId: "conn-1" });
    expect(status.cli?.version).toBe(VERSION);
    if (process.argv[1]) {
      expect(status.cli?.entrypoint).toBe(process.argv[1]);
    }
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
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

  it("uses configured handshake timeout as the default daemon probe budget", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        handshakeTimeoutMs: 30_000,
        auth: { token: "daemon-token" },
      },
    };

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    const probeInput = callArg(callGatewayStatusProbe) as {
      config?: unknown;
      preauthHandshakeTimeoutMs?: number;
      timeoutMs?: number;
    };
    expect(probeInput.config).toBe(daemonLoadedConfig);
    expect(probeInput.preauthHandshakeTimeoutMs).toBe(30_000);
    expect(probeInput.timeoutMs).toBe(30_000);
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
      findStaleOpenClawUpdateLaunchdJobs.mockResolvedValueOnce([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
      ]);

      const status = await gatherDaemonStatus({
        rpc: {},
        probe: false,
        deep: true,
      });

      expect(status.service.staleUpdateLaunchdJobs).toEqual([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
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
    process.env.OPENCLAW_STATE_DIR = tmp;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
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
    process.env.OPENCLAW_STATE_DIR = tmp;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
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
    process.env.DAEMON_GATEWAY_PASSWORD = "daemon-secretref-password"; // pragma: allowlist secret

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
    process.env.DAEMON_GATEWAY_TOKEN = "daemon-secretref-token";

    await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect((callArg(callGatewayStatusProbe) as { token?: string }).token).toBe(
      "daemon-secretref-token",
    );
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
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password"; // pragma: allowlist secret

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
});
