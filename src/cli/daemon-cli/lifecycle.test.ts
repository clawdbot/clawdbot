// Daemon lifecycle tests cover CLI service lifecycle orchestration and cleanup.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  expectRestartError,
  requireMockCallArg,
  type RestartParams,
} from "./lifecycle.test-helpers.js";

type RestartHealthSnapshot = {
  healthy: boolean;
  staleGatewayPids: number[];
  runtime: { status?: string };
  portUsage: { port: number; status: string; listeners: []; hints: []; errors?: string[] };
  waitOutcome?: string;
  elapsedMs?: number;
};

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
};
const isDefaultInstallIdentity = vi.hoisted(() => vi.fn(() => true));

const runServiceStart = vi.fn();
const runServiceRestart = vi.fn();
const runServiceStop = vi.fn();
const waitForGatewayHealthyListener = vi.fn();
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderGatewayPortHealthDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18789));
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
const signalVerifiedGatewayPidSync = vi.fn<(pid: number, signal: "SIGTERM" | "SIGUSR1") => void>();
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const formatGatewayPidList = vi.fn<(pids: number[]) => string>((pids) => pids.join(", "));
const probeGateway = vi.fn<
  (opts: {
    url: string;
    auth?: { token?: string; password?: string };
    timeoutMs: number;
  }) => Promise<{
    ok: boolean;
    configSnapshot: unknown;
  }>
>();
const callGatewayCli = vi.fn();
const isRestartEnabled = vi.fn<(config?: { commands?: unknown }) => boolean>(() => true);
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const readActiveGatewayLockPort = vi.hoisted(() => vi.fn<() => Promise<number | undefined>>());
const readActiveGatewayLockIdentity = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      | {
          pid: number;
          ownerId?: string;
          createdAt: string;
          port: number;
        }
      | undefined
    >
  >(),
);
const recoverInstalledLaunchAgent = vi.hoisted(() => vi.fn());
const repairLoadedGatewayServiceForStart = vi.hoisted(() => vi.fn());
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<() => Promise<{ scope: "user" | "system"; unitName: string; unitPath: string } | null>>(
    async () => null,
  ),
);
const restartSystemdService = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" }>>(async () => ({ outcome: "completed" })),
);
const stopSystemdService = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const isTerminalInteractive = vi.fn(() => true);
const probePortUsage = vi.fn<(port: number) => Promise<"busy" | "free" | "unknown">>(
  async () => "free",
);
const appendGatewayLifecycleAudit = vi.fn();
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../config/paths.js", () => ({
  isDefaultInstallIdentity: () => isDefaultInstallIdentity(),
  resolveNativeServiceProfileConflict: () => null,
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync: (pid: number, signal: "SIGTERM" | "SIGUSR1") =>
    signalVerifiedGatewayPidSync(pid, signal),
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: () => readActiveGatewayLockPort(),
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  isSameGatewayLockIdentity: (
    previous: { ownerId?: string; pid: number; createdAt: string; startTime?: number },
    current: { ownerId?: string; pid: number; createdAt: string; startTime?: number },
  ) =>
    previous.ownerId && current.ownerId
      ? previous.ownerId === current.ownerId
      : previous.pid === current.pid &&
        previous.createdAt === current.createdAt &&
        previous.startTime === current.startTime,
}));

vi.mock("../../infra/restart-intent.js", () => ({
  writeGatewayRestartIntentSync: (params: unknown) => writeGatewayRestartIntentSync(params),
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: {
    url: string;
    auth?: { token?: string; password?: string };
    timeoutMs: number;
  }) => probeGateway(opts),
}));

vi.mock("../../gateway/call.js", () => ({
  callGatewayCli: (opts: unknown) => callGatewayCli(opts),
}));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: (config?: { commands?: unknown }) => isRestartEnabled(config),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: () => findInstalledSystemdGatewayScope(),
  restartSystemdService: () => restartSystemdService(),
  stopSystemdService: () => stopSystemdService(),
}));

vi.mock("./launchd-recovery.js", () => ({
  recoverInstalledLaunchAgent: (args: { result: "started" | "restarted" }) =>
    recoverInstalledLaunchAgent(args),
}));

vi.mock("./start-repair.js", () => ({
  repairLoadedGatewayServiceForStart: (args: unknown) => repairLoadedGatewayServiceForStart(args),
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE:
    "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force if you really mean it.",
}));

vi.mock("../../infra/ports-probe.js", () => ({
  probePortUsage: (port: number) => probePortUsage(port),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
}));

vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
  renderGatewayPortHealthDiagnostics,
  terminateStaleGatewayPids,
  renderRestartDiagnostics,
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall: vi.fn(),
}));

describe("runDaemonRestart health checks", () => {
  let runDaemonStart: typeof import("./lifecycle.js").runDaemonStart;
  let runDaemonRestart: typeof import("./lifecycle.js").runDaemonRestart;
  let runDaemonStop: typeof import("./lifecycle.js").runDaemonStop;
  let envSnapshot: ReturnType<typeof captureEnv>;

  function mockUnmanagedRestart({
    runPostRestartCheck = false,
  }: {
    runPostRestartCheck?: boolean;
  } = {}) {
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        if (runPostRestartCheck) {
          await params.postRestartCheck?.({
            json: Boolean(params.opts?.json),
            stdout: process.stdout,
            warnings: [],
            fail: (message: string) => {
              throw new Error(message);
            },
          });
        }
        return true;
      },
    );
  }

  async function runUnmanagedStop(opts: { json?: boolean; force?: boolean } = { json: true }) {
    let outcome: unknown;
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        outcome = await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );
    await runDaemonStop(opts);
    return outcome;
  }

  beforeAll(async () => {
    ({ runDaemonStart, runDaemonRestart, runDaemonStop } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_CONTAINER_HINT",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SYSTEMD_UNIT",
    ]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    service.readCommand.mockReset();
    service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
    service.restart.mockReset().mockResolvedValue({ outcome: "completed" });
    service.stop.mockReset();
    runServiceStart.mockReset().mockResolvedValue(undefined);
    runServiceRestart.mockReset();
    runServiceStop.mockReset().mockResolvedValue(undefined);
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset().mockImplementation(() => {});
    writeGatewayRestartIntentSync.mockReset().mockReturnValue(true);
    clearGatewayRestartIntentSync.mockReset();
    formatGatewayPidList.mockReset().mockImplementation((pids) => pids.join(", "));
    probeGateway.mockReset();
    callGatewayCli.mockReset();
    isRestartEnabled.mockReset();
    loadConfig.mockReset();
    readActiveGatewayLockPort.mockReset().mockResolvedValue(undefined);
    readActiveGatewayLockIdentity.mockReset();
    recoverInstalledLaunchAgent.mockReset().mockResolvedValue(null);
    repairLoadedGatewayServiceForStart.mockReset();
    isTerminalInteractive.mockReset().mockReturnValue(true);
    probePortUsage.mockReset().mockResolvedValue("free");
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    isDefaultInstallIdentity.mockReset().mockReturnValue(true);

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4200,
      ownerId: "gateway-owner-old",
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    restartSystemdService.mockReset().mockResolvedValue({ outcome: "completed" });
    stopSystemdService.mockReset().mockResolvedValue(undefined);

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      const fail = (message: string, hints?: string[]) => {
        const err = new Error(message) as Error & { hints?: string[] };
        err.hints = hints;
        throw err;
      };
      await params.postRestartCheck?.({
        json: Boolean(params.opts?.json),
        stdout: process.stdout,
        warnings: [],
        fail,
      });
      return true;
    });
    waitForGatewayHealthyListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: true } },
    });
    callGatewayCli.mockResolvedValue({
      ok: true,
      status: "deferred",
      preflight: {
        safe: false,
        counts: {
          queueSize: 1,
          pendingReplies: 0,
          embeddedRuns: 0,
          activeTasks: 0,
          totalActive: 1,
        },
        blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
        summary: "restart deferred: 1 queued or active operation(s)",
      },
      restart: {
        ok: true,
        pid: 123,
        signal: "SIGUSR1",
        delayMs: 0,
        mode: "emit",
        coalesced: false,
        cooldownMsApplied: 0,
      },
    });
    isRestartEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("re-bootstraps an installed LaunchAgent when start finds it not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockResolvedValue({
      result: "started",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    runServiceStart.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStart({ json: true });

    expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result: "started" });
  });

  it("preserves an install-time port override when config does not own the port", async () => {
    await runDaemonStart({ json: true });
    await runDaemonRestart({ json: true });

    expect(requireMockCallArg(runServiceStart, "runServiceStart").expectedPort).toBeUndefined();
    expect(requireMockCallArg(runServiceRestart, "runServiceRestart").expectedPort).toBeUndefined();
  });

  it("guards loaded service restart at the native mutation boundary", async () => {
    await runDaemonRestart({ json: true });

    const restartParams = requireMockCallArg(runServiceRestart, "runServiceRestart");
    isDefaultInstallIdentity.mockReturnValue(false);
    expect(() => (restartParams.beforeServiceMutation as () => void)()).toThrow(
      /non-default state dir/,
    );
  });

  it("uses the installed service environment for managed restart health", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-caller-state";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway-maintenance.service";
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-service-state",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      },
    });

    await runDaemonRestart({ json: true });

    const waitParams = requireMockCallArg(
      waitForGatewayHealthyRestart,
      "waitForGatewayHealthyRestart",
    ) as { env?: NodeJS.ProcessEnv };
    expect(waitParams.env?.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-service-state");
    expect(waitParams.env?.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-maintenance.service");
  });

  it("carries launchd KeepAlive supervision into managed restart health", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonRestart({ json: true });

    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ supervisorKeepsAlive: true }),
    );
  });

  it("re-reads the installed service environment after restart repair", async () => {
    service.readCommand
      .mockResolvedValueOnce({
        programArguments: ["openclaw", "gateway", "--port", "18789"],
        environment: { OPENCLAW_STATE_DIR: "/tmp/openclaw-stale-state" },
      })
      .mockResolvedValue({
        programArguments: ["openclaw", "gateway", "--port", "19001"],
        environment: { OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state" },
      });
    repairLoadedGatewayServiceForStart.mockResolvedValue({
      result: "restarted",
      message: "Gateway service definition repaired and restarted.",
      loaded: true,
    });
    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await params.repairLoadedService?.({
        json: true,
        stdout: process.stdout,
        state: {},
        issues: [{ code: "version-mismatch", message: "old service" }],
      });
      await params.postRestartCheck?.({
        json: true,
        stdout: process.stdout,
        warnings: [],
        fail: (message: string) => {
          throw new Error(message);
        },
      });
      return true;
    });

    await runDaemonRestart({ json: true });

    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 19_001,
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
        }),
      }),
    );
  });

  it("skips unmanaged signaling for pids that are not live gateway processes", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);

    const outcome = await runUnmanagedStop();

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).not.toHaveBeenCalled();
    expect(outcome).toBeNull();
  });

  it("throws when port is busy but no gateway process can be identified", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    probePortUsage.mockResolvedValue("busy");

    await expect(runUnmanagedStop()).rejects.toThrow(
      /Port 18789 is in use but the gateway process could not be identified/,
    );

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(probePortUsage).toHaveBeenCalledWith(18789);
  });
});
