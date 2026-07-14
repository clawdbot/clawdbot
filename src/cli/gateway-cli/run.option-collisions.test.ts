// Gateway run option collision tests cover gateway run flag registration boundaries.
import { createServer } from "node:http";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../../daemon/constants.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import {
  captureEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnvAsync,
} from "../../test-utils/env.js";
import { getFreePort } from "../../test-utils/ports.js";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const setConsoleSubsystemFilter = vi.fn((_filters: string[]) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const cleanStaleGatewayProcessesSync = vi.fn(
  (_port?: number, _options?: { protectedPid?: number }) => [],
);
const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn((_port: number) => [] as number[]);
const formatGatewayPidList = vi.fn((pids: number[]) => pids.join(", "));
const isTerminalInteractive = vi.fn(() => true);
const offerInvalidConfigRecovery = vi.fn(async () => ({ status: "declined" as const }));
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
type GatewayLoopStart = (params?: { startupStartedAt?: number }) => Promise<unknown>;
const runGatewayLoop = vi.fn(async ({ start }: { start: GatewayLoopStart }) => {
  await start();
});
const normalizeStateDirEnv = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
const pinConfigDir = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
const pinRuntimePaths = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
type RuntimeDotEnvLoadResult = {
  gatewayEnvAppliedKeys: string[];
  stateEnvAppliedKeys: string[];
};
const loadGlobalRuntimeDotEnvFiles = vi.fn<
  (_opts?: unknown) => RuntimeDotEnvLoadResult | undefined
>(() => undefined);
const beforeRun = vi.fn(async () => {
  callOrder.push("bootstrap");
});
const callOrder = vi.hoisted(() => [] as string[]);
const refreshManagedProxy = vi.fn(async () => {
  callOrder.push("proxy");
});
const loadShellEnvFallback = vi.fn((_opts?: unknown) => {
  callOrder.push("shell-env");
});
const clearShellEnvAppliedKeys = vi.fn((_keys: readonly string[]) => undefined);
const resolveShellEnvExpectedKeys = vi.fn((_env?: NodeJS.ProcessEnv) => ["OPENCLAW_GATEWAY_TOKEN"]);
const resolveShellEnvFallbackTimeoutMs = vi.fn((_env?: NodeJS.ProcessEnv) => 15_000);
const shouldDeferShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const shouldEnableShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const gatewayLogMessages = vi.hoisted(() => [] as string[]);
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { config: {}, exists: false, sourceConfig: {}, valid: true } as Record<string, unknown>,
}));
const pristineStartupMigrationPlan = vi.hoisted(() => ({
  config: vi.fn(),
  state: vi.fn(),
}));
const readBestEffortConfig = vi.fn(async () => configState.cfg);
type ConfigSnapshotReadOptionsStub = {
  isolateEnv?: boolean;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  recoverSuspicious?: boolean;
  allowSuspiciousRecovery?: (
    candidate: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
};
const readConfigFileSnapshotWithPluginMetadata = vi.fn(
  async (_options?: ConfigSnapshotReadOptionsStub) => ({
    snapshot: configState.snapshot,
  }),
);
const writeDiagnosticStabilityBundleForFailureSync = vi.fn((_reason: string, _error: unknown) => ({
  status: "written" as const,
  message: "wrote stability bundle: /tmp/openclaw-stability.json",
  path: "/tmp/openclaw-stability.json",
}));
const bootLifecycle = vi.hoisted(() => ({
  decisions: [] as Array<{
    tripped: boolean;
    uncleanBoots: number;
    windowMs: number;
    shouldWriteStabilityBundle: boolean;
    recovered: boolean;
  }>,
  inspect: vi.fn(
    (_env?: NodeJS.ProcessEnv, _nowMs?: number) =>
      bootLifecycle.decisions.shift() ?? {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: false,
      },
  ),
  record: vi.fn((_env?: NodeJS.ProcessEnv, _nowMs?: number, _reason?: string) => "boot-id"),
  complete: vi.fn(),
}));
const netState = vi.hoisted(() => ({
  autoBindHost: "127.0.0.1",
  container: false,
}));
const withoutSupervisorEnv = Object.fromEntries(
  SUPERVISOR_HINT_ENV_VARS.map((key) => [key, undefined]),
) as Record<string, string | undefined>;
const withoutGatewayAuthEnv = {
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
  OPENCLAW_HOSTING_PROFILE: undefined,
};

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
// gateway run exports --token/--password into process.env as a side effect
// (see runGatewayCli auth wiring); snapshot and clear them so shared vitest
// workers do not leak credentials into later files' gateway connects.
const serviceEnvSnapshot = captureEnv([
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_RUNTIME_ID",
  "OPENCLAW_INCARNATION_ID",
]);

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  readBestEffortConfig: () => readBestEffortConfig(),
  readConfigFileSnapshot: async () => configState.snapshot,
  readConfigFileSnapshotWithPluginMetadata: (options?: ConfigSnapshotReadOptionsStub) =>
    readConfigFileSnapshotWithPluginMetadata(options),
}));

vi.mock("../../commands/doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupConfigMigrations: (config: unknown, env?: NodeJS.ProcessEnv) =>
    pristineStartupMigrationPlan.config(config, env),
  planPristineStartupStateMigrations: (env?: NodeJS.ProcessEnv) =>
    pristineStartupMigrationPlan.state(env),
}));

vi.mock("../../config/paths.js", () => ({
  CONFIG_PATH: "/tmp/openclaw-test-missing-config.json",
  normalizeStateDirEnv: (env?: NodeJS.ProcessEnv) => normalizeStateDirEnv(env),
  pinRuntimePaths: (env?: NodeJS.ProcessEnv) => pinRuntimePaths(env),
  resolveConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  resolveStateDir: () => "/tmp",
  resolveGatewayPort: (cfg?: { gateway?: { port?: number } }) => cfg?.gateway?.port ?? 18789,
}));

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  pinConfigDir: (env?: NodeJS.ProcessEnv) => pinConfigDir(env),
}));

vi.mock("../../infra/dotenv-global.js", () => ({
  loadGlobalRuntimeDotEnvFiles: (opts?: unknown) =>
    loadGlobalRuntimeDotEnvFiles(opts) ?? {
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    },
}));

vi.mock("../../config/shell-env-expected-keys.js", () => ({
  resolveShellEnvExpectedKeys: (env?: NodeJS.ProcessEnv) => resolveShellEnvExpectedKeys(env),
}));

vi.mock("../../infra/shell-env.js", () => ({
  clearShellEnvAppliedKeys: (keys: readonly string[]) => clearShellEnvAppliedKeys(keys),
  loadShellEnvFallback: (opts?: unknown) => loadShellEnvFallback(opts),
  resolveShellEnvFallbackTimeoutMs: (env?: NodeJS.ProcessEnv) =>
    resolveShellEnvFallbackTimeoutMs(env),
  shouldDeferShellEnvFallback: (env?: NodeJS.ProcessEnv) => shouldDeferShellEnvFallback(env),
  shouldEnableShellEnvFallback: (env?: NodeJS.ProcessEnv) => shouldEnableShellEnvFallback(env),
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: {
    authConfig?: { mode?: string; token?: unknown; password?: unknown };
    authOverride?: { mode?: string; token?: unknown; password?: unknown };
    env?: NodeJS.ProcessEnv;
  }) => {
    const mode = params.authOverride?.mode ?? params.authConfig?.mode ?? "token";
    const token =
      (typeof params.authOverride?.token === "string" ? params.authOverride.token : undefined) ??
      (typeof params.authConfig?.token === "string" ? params.authConfig.token : undefined) ??
      params.env?.OPENCLAW_GATEWAY_TOKEN;
    const password =
      (typeof params.authOverride?.password === "string"
        ? params.authOverride.password
        : undefined) ??
      (typeof params.authConfig?.password === "string" ? params.authConfig.password : undefined) ??
      params.env?.OPENCLAW_GATEWAY_PASSWORD;
    return {
      mode,
      token,
      password,
      allowTailscale: false,
    };
  },
}));

vi.mock("../../gateway/net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/net.js")>();
  return {
    ...actual,
    defaultGatewayBindMode: (tailscaleMode?: string) => {
      if (tailscaleMode && tailscaleMode !== "off") {
        return "loopback";
      }
      return netState.container ? "auto" : "loopback";
    },
    isContainerEnvironment: () => netState.container,
    resolveGatewayBindHost: async (bind?: string, customHost?: string) => {
      if (bind === "auto") {
        return netState.autoBindHost;
      }
      if (bind === "lan") {
        return "0.0.0.0";
      }
      if (bind === "custom") {
        return customHost?.trim() || "0.0.0.0";
      }
      if (bind === "tailnet") {
        return "100.64.0.1";
      }
      return "127.0.0.1";
    },
  };
});

vi.mock("../../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (port?: number, options?: { protectedPid?: number }) =>
    cleanStaleGatewayProcessesSync(port, options),
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  GatewayLockError: class GatewayLockError extends Error {},
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../infra/supervisor-markers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/supervisor-markers.js")>();
  return {
    ...actual,
    detectRespawnSupervisor: () => null,
  };
});

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: (filters: string[]) => setConsoleSubsystemFilter(filters),
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync: (reason: string, error: unknown) =>
    writeDiagnosticStabilityBundleForFailureSync(reason, error),
}));

vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  GATEWAY_CRASH_LOOP_BREAKER_REASON: "gateway.crash_loop_breaker",
  GATEWAY_CRASH_LOOP_RECOVERED_REASON: "gateway.crash_loop_recovered",
  inspectGatewayCrashLoopBreaker: (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.inspect(env, nowMs),
  recordGatewayBootStart: (env?: NodeJS.ProcessEnv, nowMs?: number, reason?: string) =>
    bootLifecycle.record(env, nowMs, reason),
  completeGatewayBootLifecycle: (bootId: string | undefined, completion: unknown) =>
    bootLifecycle.complete(bootId, completion),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: () => undefined,
    info: (message: string) => {
      gatewayLogMessages.push(message);
    },
    warn: (message: string) => {
      gatewayLogMessages.push(message);
    },
    error: () => undefined,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE:
    "Refusing to kill the operator's running gateway service from a non-interactive shell. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing.",
}));

vi.mock("../invalid-config-recovery.js", () => ({
  offerInvalidConfigRecovery: () => offerInvalidConfigRecovery(),
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
  waitForPortBindable: (port: number, opts?: unknown) => waitForPortBindable(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: GatewayLoopStart }) => runGatewayLoop(params),
}));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run-command.js").addGatewayRunCommand;
  let sharedProgram: Command;

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run-command.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    const gateway = addGatewayRunCommand(sharedProgram.command("gateway"), { beforeRun });
    addGatewayRunCommand(gateway.command("run"), { beforeRun });
  });

  afterAll(() => {
    serviceEnvSnapshot.restore();
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_HOSTING_PROFILE;
    delete process.env.OPENCLAW_RUNTIME_ID;
    delete process.env.OPENCLAW_INCARNATION_ID;
    deleteTestEnvValue(GATEWAY_SERVICE_RUNTIME_PID_ENV);
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { config: {}, exists: false, sourceConfig: {}, valid: true };
    pristineStartupMigrationPlan.config.mockReset();
    pristineStartupMigrationPlan.config.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    pristineStartupMigrationPlan.state.mockReset();
    pristineStartupMigrationPlan.state.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    netState.autoBindHost = "127.0.0.1";
    netState.container = false;
    readBestEffortConfig.mockClear();
    readConfigFileSnapshotWithPluginMetadata.mockClear();
    gatewayLogMessages.length = 0;
    writeDiagnosticStabilityBundleForFailureSync.mockClear();
    bootLifecycle.decisions.length = 0;
    bootLifecycle.inspect.mockClear();
    bootLifecycle.record.mockClear();
    bootLifecycle.complete.mockClear();
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    setConsoleSubsystemFilter.mockClear();
    forceFreePortAndWait.mockClear();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    formatGatewayPidList.mockClear();
    isTerminalInteractive.mockReset();
    isTerminalInteractive.mockReturnValue(true);
    offerInvalidConfigRecovery.mockClear();
    cleanStaleGatewayProcessesSync.mockClear();
    waitForPortBindable.mockClear();
    ensureDevGatewayConfig.mockClear();
    runGatewayLoop.mockClear();
    normalizeStateDirEnv.mockReset();
    pinConfigDir.mockClear();
    pinRuntimePaths.mockClear();
    loadGlobalRuntimeDotEnvFiles.mockReset();
    beforeRun.mockClear();
    refreshManagedProxy.mockClear();
    loadShellEnvFallback.mockClear();
    clearShellEnvAppliedKeys.mockClear();
    resolveShellEnvExpectedKeys.mockClear();
    resolveShellEnvFallbackTimeoutMs.mockClear();
    shouldDeferShellEnvFallback.mockReset();
    shouldDeferShellEnvFallback.mockReturnValue(false);
    shouldEnableShellEnvFallback.mockReset();
    shouldEnableShellEnvFallback.mockReturnValue(false);
    callOrder.length = 0;
  });

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  async function prepareGatewayReset() {
    const { prepareGatewayRunBootstrap } = await import("./pre-bootstrap.js");
    return await prepareGatewayRunBootstrap({ opts: { reset: true }, runtime: defaultRuntime });
  }

  function callArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`Expected mock call ${index}`);
    }
    return call[argIndex];
  }

  function gatewayStartOptions(index = 0) {
    expect(startGatewayServer.mock.calls[index]?.[0]).toBe(18789);
    return callArg(startGatewayServer, index, 1) as {
      auth?: { mode?: string; token?: string; password?: string };
      bind?: string;
      channelAutostartSuppression?: { reason?: string };
      ambientEnvTriggers?: "allow" | "suppress";
      startupConfigSnapshotRead?: { snapshot?: Record<string, unknown> };
      startupStartedAt?: number;
    };
  }

  function expectAuthOverrideMode(mode: string) {
    expect(gatewayStartOptions().auth?.mode).toBe(mode);
  }

  it("runs the fast-path bootstrap hook before gateway startup", async () => {
    normalizeStateDirEnv.mockImplementation((_env?: NodeJS.ProcessEnv) => {
      callOrder.push("normalize");
    });
    startGatewayServer.mockImplementationOnce(async (_port: number, _opts?: unknown) => {
      callOrder.push("start");
      return { close: vi.fn(async () => {}) };
    });

    await runGatewayCli(["gateway", "--allow-unconfigured"]);

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["bootstrap", "normalize", "normalize", "start"]);
  });

  it("suppresses ambient channel triggers for dev gateways by default", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev"]);

    expect(gatewayStartOptions().ambientEnvTriggers).toBe("suppress");
  });

  it("allows ambient channel triggers with the explicit dev override", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--allow-unconfigured",
      "--dev",
      "--dev-ambient-channels",
    ]);

    expect(gatewayStartOptions().ambientEnvTriggers).toBe("allow");
  });

  it("rejects the ambient channel override outside dev mode", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev-ambient-channels"]),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain("Use --dev-ambient-channels with --dev.");
  });

  it("drops the pristine core fact when guarded config becomes stateful", async () => {
    const initialConfig = {
      gateway: { mode: "local" },
      plugins: { load: { paths: ["/plugins/example"] } },
    };
    configState.snapshot = {
      config: initialConfig,
      exists: true,
      hash: "initial",
      parsed: initialConfig,
      path: "/tmp/openclaw.json",
      sourceConfig: initialConfig,
      valid: true,
    };
    pristineStartupMigrationPlan.state.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
    const {
      prepareGatewayRunBootstrap,
      selectGatewayRunEnvironment,
      wasPreparedGatewayRunCoreStatePristine,
    } = await import("./pre-bootstrap.js");

    expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
    const recoveredConfig = {
      gateway: { mode: "local" },
      session: { store: "/tmp/sessions.json" },
    };
    configState.snapshot = {
      config: recoveredConfig,
      exists: true,
      hash: "recovered",
      parsed: recoveredConfig,
      path: "/tmp/openclaw.json",
      sourceConfig: recoveredConfig,
      valid: true,
    };

    expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
    expect(wasPreparedGatewayRunCoreStatePristine()).toBe(false);
    expect(pristineStartupMigrationPlan.config).toHaveBeenCalledWith(recoveredConfig, process.env);
  });

  it("refreshes the managed proxy from the final accepted config before gateway startup", async () => {
    const finalConfig = {
      gateway: { mode: "local" },
      proxy: { enabled: true, proxyUrl: "http://127.0.0.1:29876" },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      config: finalConfig,
      parsed: finalConfig,
      sourceConfig: finalConfig,
    };
    const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
    try {
      await runGatewayCli(["gateway"]);
    } finally {
      uninstall();
    }

    expect(refreshManagedProxy).toHaveBeenCalledWith(finalConfig.proxy);
    const refreshOrder = refreshManagedProxy.mock.invocationCallOrder[0] ?? 0;
    const startOrder = startGatewayServer.mock.invocationCallOrder[0] ?? 0;
    expect(startOrder).toBeGreaterThan(refreshOrder);
  });

  it("loads configured shell env fallback before final proxy refresh and gateway startup", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const finalConfig = {
        env: {
          shellEnv: { enabled: true, timeoutMs: 1234 },
          vars: { OPENCLAW_GATEWAY_TOKEN: "config-token" },
        },
        gateway: {
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
          mode: "local",
        },
        proxy: { enabled: true, proxyUrl: "http://127.0.0.1:29876" },
      };
      configState.snapshot = {
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        config: finalConfig,
        parsed: finalConfig,
        sourceConfig: finalConfig,
      };
      readConfigFileSnapshotWithPluginMetadata
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: configState.snapshot };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return {
            snapshot: {
              ...configState.snapshot,
              config: {
                ...finalConfig,
                gateway: {
                  ...finalConfig.gateway,
                  auth: { mode: "token", token: "config-token" },
                },
              },
            },
          };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        callOrder.push("shell-env");
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });
      const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
      try {
        await runGatewayCli(["gateway"]);
      } finally {
        uninstall();
      }

      expect(loadShellEnvFallback).toHaveBeenCalledWith({
        enabled: true,
        env: process.env,
        expectedKeys: ["OPENCLAW_GATEWAY_TOKEN"],
        logger: expect.any(Object),
        timeoutMs: 1234,
      });
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          lowerPrecedenceEnv: { OPENCLAW_GATEWAY_TOKEN: "shell-token" },
        }),
      );
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(2);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("config-token");
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      const shellEnvOrder = loadShellEnvFallback.mock.invocationCallOrder[0] ?? 0;
      const initialConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[0] ?? 0;
      const finalConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[1] ?? 0;
      const refreshOrder = refreshManagedProxy.mock.invocationCallOrder[0] ?? 0;
      const startOrder = startGatewayServer.mock.invocationCallOrder[0] ?? 0;
      expect(shellEnvOrder).toBeGreaterThan(initialConfigReadOrder);
      expect(finalConfigReadOrder).toBeGreaterThan(shellEnvOrder);
      expect(refreshOrder).toBeGreaterThan(shellEnvOrder);
      expect(startOrder).toBeGreaterThan(refreshOrder);
    });
  });

  it("lets config env aliases replace canonical shell fallback values", async () => {
    await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      const finalConfig = {
        env: {
          shellEnv: { enabled: true },
          vars: { Z_AI_API_KEY: "config-key" },
        },
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      configState.snapshot = {
        config: finalConfig,
        exists: true,
        parsed: finalConfig,
        path: "/tmp/openclaw.json",
        sourceConfig: finalConfig,
        valid: true,
      };
      resolveShellEnvExpectedKeys
        .mockReturnValueOnce(["ZAI_API_KEY"])
        .mockReturnValueOnce(["ZAI_API_KEY"]);
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.ZAI_API_KEY = "shell-key";
      });

      await runGatewayCli(["gateway"]);

      expect(process.env.Z_AI_API_KEY).toBe("config-key");
      expect(process.env.ZAI_API_KEY).toBe("config-key");
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["ZAI_API_KEY"]);
    });
  });

  it("removes shell fallback values when the final accepted config disables fallback", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const enabledConfig = {
        env: { shellEnv: { enabled: true } },
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const disabledConfig = {
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const snapshot = (config: Record<string, unknown>) => ({
        config,
        exists: true,
        parsed: config,
        path: "/tmp/openclaw.json",
        sourceConfig: config,
        valid: true,
      });
      readConfigFileSnapshotWithPluginMetadata
        .mockResolvedValueOnce({ snapshot: snapshot(enabledConfig) })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return { snapshot: snapshot(disabledConfig) };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: snapshot(disabledConfig) };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });

      await runGatewayCli(["gateway"]);

      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(3);
      expect(loadShellEnvFallback).toHaveBeenCalledOnce();
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(startGatewayServer).toHaveBeenCalledOnce();
    });
  });

  it("uses config env shell fallback controls without mutating the live env during planning", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      },
      async () => {
        const finalConfig = {
          env: {
            vars: {
              OPENCLAW_LOAD_SHELL_ENV: "1",
              OPENCLAW_SHELL_ENV_TIMEOUT_MS: "4321",
            },
          },
          gateway: { auth: { mode: "none" }, mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          parsed: finalConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };
        shouldEnableShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        resolveShellEnvFallbackTimeoutMs.mockImplementationOnce((env?: NodeJS.ProcessEnv) =>
          Number(env?.OPENCLAW_SHELL_ENV_TIMEOUT_MS),
        );

        await runGatewayCli(["gateway"]);

        expect(loadShellEnvFallback).toHaveBeenCalledWith(
          expect.objectContaining({ enabled: true, timeoutMs: 4321 }),
        );
        expect(process.env.OPENCLAW_LOAD_SHELL_ENV).toBe("1");
        expect(process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS).toBe("4321");
      },
    );
  });

  it("honors config env shell fallback deferral", async () => {
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
      },
      async () => {
        const finalConfig = {
          env: {
            vars: {
              OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1",
              OPENCLAW_LOAD_SHELL_ENV: "1",
            },
          },
          gateway: { auth: { mode: "none" }, mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          parsed: finalConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };
        shouldEnableShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway"]);

        expect(resolveShellEnvExpectedKeys).not.toHaveBeenCalled();
        expect(loadShellEnvFallback).not.toHaveBeenCalled();
      },
    );
  });

  it("ignores shell fallback controls from invalid config", async () => {
    const { clearGatewayRunConfigEnvironment } = await import("./pre-bootstrap.js");
    clearGatewayRunConfigEnvironment();
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: "1",
      },
      async () => {
        const invalidConfig = {
          env: { vars: { OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: invalidConfig,
          exists: true,
          issues: [{ path: "gateway", message: "invalid" }],
          parsed: invalidConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: invalidConfig,
          valid: false,
        };
        shouldEnableShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway", "--allow-unconfigured"]);

        expect(loadShellEnvFallback).toHaveBeenCalledOnce();
        expect(startGatewayServer).toHaveBeenCalledOnce();
      },
    );
  });

  it("rejects an invalid final config after a prepared config selected runtime paths", async () => {
    const selectedStateDir = "/tmp/openclaw-prepared-selected-state";
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const selectedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: selectedConfig,
        exists: true,
        parsed: selectedConfig,
        path: "/tmp/openclaw.json",
        sourceConfig: selectedConfig,
        valid: true,
      };
      const {
        applyFinalGatewayRunConfigEnv,
        prepareGatewayRunBootstrap,
        selectGatewayRunEnvironment,
      } = await import("./pre-bootstrap.js");

      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);

      const invalidSnapshot = {
        ...configState.snapshot,
        issues: [{ message: "invalid", path: "gateway" }],
        valid: false,
      };
      await expect(
        applyFinalGatewayRunConfigEnv({
          runtime: defaultRuntime,
          snapshot: invalidSnapshot as ConfigFileSnapshot,
        }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.join("\n")).toContain("final config read became invalid");
      expect(startGatewayServer).not.toHaveBeenCalled();
    });
  });

  it("replaces config-derived env when the final startup snapshot changes in place", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROXY_URL: undefined,
        OPENCLAW_RAW_STREAM: undefined,
      },
      async () => {
        const oldConfig = {
          env: {
            vars: {
              OPENCLAW_GATEWAY_TOKEN: "old-token",
              OPENCLAW_PROXY_URL: "http://127.0.0.1:19876",
              OPENCLAW_RAW_STREAM: "1",
            },
          },
          gateway: { mode: "local" },
        };
        const newConfig = {
          env: { vars: { OPENCLAW_GATEWAY_TOKEN: "new-token" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: oldConfig,
          exists: true,
          hash: "old",
          path: "/tmp/openclaw.json",
          sourceConfig: oldConfig,
          valid: true,
        };
        const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
          await import("./pre-bootstrap.js");
        await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
        await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
        expect(pinRuntimePaths).toHaveBeenCalledWith(process.env);
        expect(pinConfigDir).toHaveBeenCalledWith(process.env);
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("old-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBe("http://127.0.0.1:19876");

        configState.snapshot = {
          config: newConfig,
          exists: true,
          hash: "new",
          path: "/tmp/openclaw.json",
          sourceConfig: newConfig,
          valid: true,
        };
        readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
          return { snapshot: configState.snapshot };
        });
        await runGatewayCli(["gateway", "--raw-stream"]);

        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("new-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
        expect(process.env.OPENCLAW_RAW_STREAM).toBe("1");
      },
    );
  });

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    normalizeStateDirEnv.mockImplementation((_env?: NodeJS.ProcessEnv) => {
      callOrder.push("normalize");
    });
    startGatewayServer.mockImplementationOnce(async (_port: number, _opts?: unknown) => {
      callOrder.push("start");
      return { close: vi.fn(async () => {}) };
    });

    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(callArg(forceFreePortAndWait, 0, 0)).toBe(18789);
    expect(callArg(waitForPortBindable, 0, 0)).toBe(18789);
    expect(
      callArg(waitForPortBindable, 0, 1) as { intervalMs?: number; timeoutMs?: number },
    ).toEqual({ intervalMs: 150, timeoutMs: 3000 });
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(gatewayStartOptions().auth?.token).toBe("tok_run");
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
    expect(callOrder).toEqual(["bootstrap", "normalize", "normalize", "start"]);
  });

  it("refuses non-interactive --force when a verified gateway appears before signaling", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4242]);
    forceFreePortAndWait.mockImplementationOnce(async (_port, opts) => {
      (opts as { beforeSignal?: () => void }).beforeSignal?.();
      return { killed: [], waitedMs: 0, escalatedToSigkill: false };
    });

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(forceFreePortAndWait).toHaveBeenCalledTimes(1);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("openclaw gateway run --dev");
    expect(runtimeErrors.join("\n")).toContain("--profile <name> with a free port");
  });

  it("marks service-mode gateway descendants with the live gateway pid", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: undefined,
      },
      async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
  });

  it("protects the inherited service pid before replacing it", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: "4242",
      },
      async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

        expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789, {
          protectedPid: 4242,
        });
        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
  });

  it("marks descendants when the final config supplies the service marker", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: undefined,
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: undefined,
      },
      async () => {
        const finalConfig = {
          env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };

        await runGatewayCli(["gateway"]);

        expect(process.env.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
  });

  it("rechecks future config after the final config enters service mode", async () => {
    await withEnvAsync(
      {
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
        OPENCLAW_SERVICE_MARKER: undefined,
      },
      async () => {
        const finalConfig = {
          env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "9999.1.1" },
        };
        configState.cfg = finalConfig;
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };

        await expect(runGatewayCli(["gateway"])).rejects.toThrow("__exit__:78");

        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(startGatewayServer).not.toHaveBeenCalled();
        expect(runtimeErrors.join("\n")).toContain("start the gateway service");
      },
    );
  });

  it("blocks --force port cleanup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to force-kill gateway port listeners");
  });

  it("blocks service-mode startup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };
    const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
    process.env.OPENCLAW_SERVICE_MARKER = "gateway";
    try {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    } finally {
      if (previousMarker === undefined) {
        delete process.env.OPENCLAW_SERVICE_MARKER;
      } else {
        process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
      }
    }

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to start the gateway service");
  });

  it("blocks dev reset from an older binary before deleting state", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(prepareGatewayReset()).rejects.toThrow("__exit__:1");

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to reset the dev gateway state");
  });

  it("blocks dev reset when parseable future-version metadata is schema-invalid", async () => {
    configState.snapshot = {
      config: {},
      exists: true,
      issues: [{ message: "unknown newer field", path: "gateway.newerField" }],
      parsed: { gateway: { newerField: true }, meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: {
        gateway: { newerField: true },
        meta: { lastTouchedVersion: "9999.1.1" },
      },
      valid: false,
    };

    await expect(prepareGatewayReset()).rejects.toThrow("__exit__:1");

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to reset the dev gateway state");
  });

  it("does not retain targets or credentials from the config deleted by dev reset", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_WORKSPACE_DIR: undefined,
      },
      async () => {
        configState.snapshot = {
          exists: true,
          valid: true,
          config: { gateway: { mode: "local" } },
          sourceConfig: {
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
              },
            },
            gateway: { mode: "local" },
          },
        };
        ensureDevGatewayConfig.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_HOME).toBeUndefined();
          expect(process.env.OPENCLAW_PROFILE).toBe("dev");
          expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-reset-workspace");
          configState.snapshot = {
            exists: true,
            valid: true,
            config: { gateway: { mode: "local" } },
            sourceConfig: { gateway: { mode: "local" } },
          };
        });
        loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
          process.env.OPENCLAW_GATEWAY_TOKEN ??= "trusted-token";
          process.env.OPENCLAW_PROFILE ??= "dev";
          if (process.env.OPENCLAW_WORKSPACE_DIR === undefined) {
            setTestEnvValue("OPENCLAW_WORKSPACE_DIR", "/tmp/openclaw-reset-workspace");
          }
        });

        await prepareGatewayReset();
        await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]);

        expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(loadGlobalRuntimeDotEnvFiles).toHaveBeenCalled();
      },
    );
  });

  it("refuses dev reset if trusted dotenv retargets after pre-bootstrap", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: "/tmp/openclaw-reset-original" }, async () => {
      configState.snapshot = {
        config: { gateway: { mode: "local" } },
        exists: true,
        path: "/tmp/openclaw-reset-original/openclaw.json",
        sourceConfig: { gateway: { mode: "local" } },
        valid: true,
      };
      await prepareGatewayReset();
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-reset-retargeted");
        return {
          gatewayEnvAppliedKeys: [],
          stateEnvAppliedKeys: ["OPENCLAW_STATE_DIR"],
        };
      });

      await expect(
        runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]),
      ).rejects.toThrow("__exit__:1");

      expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-reset-original");
      expect(runtimeErrors.join("\n")).toContain(
        "selected config or state target changed during startup",
      );
    });
  });

  it.each([
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_INCLUDE_ROOTS",
    "OPENCLAW_NIX_MODE",
    "OPENCLAW_OAUTH_DIR",
    "OPENCLAW_PACKAGE_DIR",
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "PI_CODING_AGENT_DIR",
  ])("blocks trusted dotenv selector drift for %s after startup mutations", async (selector) => {
    await withEnvAsync({ [selector]: "/tmp/openclaw-reset-value" }, async () => {
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue(selector, "/tmp/openclaw-reset-retargeted");
      });
      const { reloadTrustedGatewayRunEnvironment } = await import("./pre-bootstrap.js");

      await expect(reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime })).rejects.toThrow(
        "__exit__:1",
      );

      expect(process.env[selector]).toBe("/tmp/openclaw-reset-value");
      expect(runtimeErrors.join("\n")).toContain(
        "trusted dotenv reload after startup mutations changed config or state selection",
      );
    });
  });

  it("blocks a future-version late recovery candidate before gateway startup", async () => {
    readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async (options) => {
      await options?.allowSuspiciousRecovery?.(
        {
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "9999.1.1" },
        },
        { gateway: { mode: "local" } },
      );
      return { snapshot: configState.snapshot };
    });

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("run automatic gateway startup migrations");
  });

  it("blocks a future-version service-mode late recovery candidate before restore", async () => {
    let recoveryAllowed: boolean | undefined;
    await withEnvAsync(
      {
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
        OPENCLAW_SERVICE_MARKER: undefined,
      },
      async () => {
        readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async (options) => {
          recoveryAllowed = await options?.allowSuspiciousRecovery?.(
            {
              env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
              gateway: { mode: "local" },
              meta: { lastTouchedVersion: "9999.1.1" },
            },
            { gateway: { mode: "local" } },
          );
          return { snapshot: configState.snapshot };
        });

        await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
          "__exit__:78",
        );
      },
    );

    expect(recoveryAllowed).toBe(false);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("start the gateway service");
  });

  it("blocks a future-version current config before suspicious recovery", async () => {
    let recoveryAllowed: boolean | undefined;
    readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async (options) => {
      recoveryAllowed = await options?.allowSuspiciousRecovery?.(
        { gateway: { mode: "local" } },
        {
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "9999.1.1" },
        },
      );
      return { snapshot: configState.snapshot };
    });

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(recoveryAllowed).toBe(false);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("run automatic gateway startup migrations");
  });

  it("blocks a final startup snapshot that changes guarded config selection", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      configState.snapshot = {
        exists: true,
        valid: true,
        config: { gateway: { mode: "local" } },
        sourceConfig: {
          env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-late-selection" } },
          gateway: { mode: "local" },
        },
      };

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it("blocks a final startup snapshot that changes an already-selected config selector", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const guardedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-guarded-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: guardedConfig,
        exists: true,
        hash: "guarded",
        path: "/tmp/openclaw.json",
        sourceConfig: guardedConfig,
        valid: true,
      };
      const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
        await import("./pre-bootstrap.js");
      await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
      await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");

      const finalConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-final-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: finalConfig,
        exists: true,
        hash: "final",
        path: "/tmp/openclaw.json",
        sourceConfig: finalConfig,
        valid: true,
      };

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it.each([
    ["--cli-backend-logs", "generic flag"],
    ["--claude-cli-logs", "deprecated alias"],
  ])("enables CLI backend log filtering via %s (%s)", async (flag) => {
    delete process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT;

    await runGatewayCli(["gateway", "run", flag, "--allow-unconfigured"]);

    expect(setConsoleSubsystemFilter).toHaveBeenCalledWith(["agent/cli-backend"]);
    expect(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT).toBe("1");
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
    });

    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledWith({
      isolateEnv: true,
      recoverSuspicious: true,
      allowSuspiciousRecovery: expect.any(Function),
    });
    expect(resolveShellEnvExpectedKeys).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
    const options = gatewayStartOptions();
    expect(options.bind).toBe("loopback");
    expect(options.startupConfigSnapshotRead).toEqual({ snapshot: configState.snapshot });
  });

  it("sets the selected hosting profile before gateway startup", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--hosting-profile",
      "container",
      "--allow-unconfigured",
    ]);

    expect(process.env.OPENCLAW_HOSTING_PROFILE).toBe("container");
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it("sets runtime activation identity before gateway startup", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--runtime-id",
      "tenant-42/scout-primary",
      "--incarnation-id",
      "pod-7f9c",
      "--allow-unconfigured",
    ]);

    expect(process.env.OPENCLAW_RUNTIME_ID).toBe("tenant-42/scout-primary");
    expect(process.env.OPENCLAW_INCARNATION_ID).toBe("pod-7f9c");
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });
  it("rejects unsupported hosting profiles before gateway startup", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--hosting-profile", "custom-host", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --hosting-profile. Use "local", "container", "reverse-proxy", "node-mode".',
    );
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("allows authless auto startup when it resolves to loopback", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await runGatewayCli(["gateway", "run", "--bind", "auto", "--allow-unconfigured"]);
    });

    const options = gatewayStartOptions();
    expect(options.bind).toBe("auto");
  });

  it("blocks container auto startup without explicit gateway auth", async () => {
    netState.autoBindHost = "0.0.0.0";
    netState.container = true;

    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to auto without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("blocks non-loopback startup without explicit gateway auth", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(
        runGatewayCli(["gateway", "run", "--bind", "lan", "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:78");
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to lan without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("allows non-loopback startup when token auth is explicit", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--bind",
      "lan",
      "--token",
      "tok_run",
      "--allow-unconfigured",
    ]);

    const options = gatewayStartOptions();
    expect(options.bind).toBe("lan");
    expect(options.auth?.token).toBe("tok_run");
  });

  it("uses the startup snapshot only for the first in-process gateway start", async () => {
    runGatewayLoop.mockImplementationOnce(async ({ start }: { start: GatewayLoopStart }) => {
      await start({ startupStartedAt: 1000 });
      await start({ startupStartedAt: 2000 });
    });

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledTimes(2);
    const firstOptions = gatewayStartOptions(0);
    expect(firstOptions.startupStartedAt).toBe(1000);
    expect(firstOptions.startupConfigSnapshotRead).toEqual({ snapshot: configState.snapshot });
    const secondOptions = gatewayStartOptions(1);
    expect(secondOptions.startupConfigSnapshotRead).toBeUndefined();
    expect(secondOptions.startupStartedAt).toBe(2000);
  });

  it("re-inspects crash-loop breaker state for each boot iteration", async () => {
    runGatewayLoop.mockImplementationOnce(
      async ({
        beginBoot,
        start,
      }: {
        beginBoot?: (startedAtMs: number) => Promise<void> | void;
        start: GatewayLoopStart;
      }) => {
        await beginBoot?.(1000);
        await start({ startupStartedAt: 1000 });
        await beginBoot?.(2000);
        await start({ startupStartedAt: 2000 });
      },
    );
    bootLifecycle.decisions.push(
      {
        tripped: true,
        uncleanBoots: 3,
        windowMs: 300_000,
        shouldWriteStabilityBundle: true,
        recovered: false,
      },
      {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: true,
      },
    );

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.inspect.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.record.mock.calls.map((call) => call[2])).toEqual([
      "gateway.crash_loop_breaker",
      "gateway.crash_loop_recovered",
    ]);
    expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledTimes(1);
    expect(gatewayStartOptions(0).channelAutostartSuppression).toMatchObject({
      reason: "crash-loop-breaker",
    });
    expect(gatewayStartOptions(1).channelAutostartSuppression).toBeUndefined();
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it("skips failure bundles but exits nonzero for unconfirmed gateway lock conflicts", async () => {
    const port = await getFreePort();
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`gateway already running on port ${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(withoutSupervisorEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:1",
      );
    });

    expect(writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
  });

  it.each([
    "gateway already running (pid 4242); lock timeout after 5000ms",
    "another gateway instance is already listening on ws://127.0.0.1",
  ])("exits 1 for unmanaged healthy-port lock conflicts: %s", async (message) => {
    const healthyGateway = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
    });
    await new Promise<void>((resolve) => {
      healthyGateway.listen(0, "127.0.0.1", resolve);
    });
    const address = healthyGateway.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    const port = address.port;
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`${message}:${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    try {
      await withEnvAsync(withoutSupervisorEnv, async () => {
        await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
          "__exit__:1",
        );
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        healthyGateway.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    }
  });

  it("blocks startup when the observed snapshot loses gateway.mode", async () => {
    configState.cfg = {
      gateway: {
        mode: "local",
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: {
        update: { channel: "beta" },
      },
      parsed: {
        update: { channel: "beta" },
      },
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(`Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
  });

  it("blocks invalid startup config without automatic recovery", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(`Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledOnce();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("keeps explicit dev reset as the recovery path for invalid config", async () => {
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await prepareGatewayReset();
    await runGatewayCli(["gateway", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("passes invalid startup snapshot through when explicitly allowed", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    const options = gatewayStartOptions();
    expect(options.bind).toBe("loopback");
    expect(options.startupConfigSnapshotRead?.snapshot?.valid).toBe(false);
  });

  it("does not offer doctor repair after --allow-unconfigured reaches startup", async () => {
    const { createInvalidConfigError } = await import("../../config/io.invalid-config.js");
    startGatewayServer.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "gateway.mode: invalid"),
    );

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );

    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it.each(["none", "trusted-proxy"] as const)("accepts --auth %s override", async (mode) => {
    await runGatewayCli(["gateway", "run", "--auth", mode, "--allow-unconfigured"]);

    expectAuthOverrideMode(mode);
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth. Use "none", "token", "password", or "trusted-proxy".',
    );
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: configState.cfg,
      parsed: configState.cfg,
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(gatewayStartOptions().bind).toBe("loopback");
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runGatewayCli([
          "gateway",
          "run",
          "--auth",
          "password",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]);
      },
    );

    const options = gatewayStartOptions();
    expect(options.auth?.mode).toBe("password");
    expect(options.auth?.password).toBe("pw_from_file"); // pragma: allowlist secret
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expect(
          runGatewayCli([
            "gateway",
            "run",
            "--password",
            "pw_inline",
            "--password-file",
            passwordFile ?? "",
            "--allow-unconfigured",
          ]),
        ).rejects.toThrow("__exit__:1");
      },
    );
    expect(runtimeErrors[0]).toContain("Use either --password or --password-file.");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
