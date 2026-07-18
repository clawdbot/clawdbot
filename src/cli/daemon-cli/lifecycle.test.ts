// Daemon lifecycle tests cover CLI service lifecycle orchestration and cleanup.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

type RestartHealthSnapshot = {
  healthy: boolean;
  staleGatewayPids: number[];
  runtime: { status?: string };
  portUsage: { port: number; status: string; listeners: []; hints: []; errors?: string[] };
  waitOutcome?: string;
  elapsedMs?: number;
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

type RestartParams = {
  opts?: { json?: boolean };
  repairLoadedService?: (ctx: {
    json: boolean;
    stdout: NodeJS.WritableStream;
    state: unknown;
    issues: unknown[];
  }) => Promise<unknown>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
};

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
const appendGatewayLifecycleAudit = vi.fn();
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

async function expectRestartError(
  promise: Promise<unknown>,
): Promise<Error & { hints?: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hints?: string[] };
  }
  throw new Error("expected restart to fail");
}

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
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
    service.readRuntime.mockReset();
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockReset();
    service.stop.mockReset();
    runServiceStart.mockReset();
    runServiceRestart.mockReset();
    runServiceStop.mockReset();
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset();
    writeGatewayRestartIntentSync.mockReset();
    clearGatewayRestartIntentSync.mockReset();
    formatGatewayPidList.mockReset();
    probeGateway.mockReset();
    callGatewayCli.mockReset();
    isRestartEnabled.mockReset();
    loadConfig.mockReset();
    readActiveGatewayLockPort.mockReset();
    readActiveGatewayLockIdentity.mockReset();
    recoverInstalledLaunchAgent.mockReset();
    repairLoadedGatewayServiceForStart.mockReset();
    isTerminalInteractive.mockReset();
    isTerminalInteractive.mockReturnValue(true);
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    service.restart.mockResolvedValue({ outcome: "completed" });
    runServiceStart.mockResolvedValue(undefined);
    recoverInstalledLaunchAgent.mockResolvedValue(null);
    readActiveGatewayLockPort.mockResolvedValue(undefined);
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4200,
      ownerId: "gateway-owner-old",
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });
    findInstalledSystemdGatewayScope.mockReset();
    findInstalledSystemdGatewayScope.mockResolvedValue(null);
    restartSystemdService.mockReset();
    restartSystemdService.mockResolvedValue({ outcome: "completed" });
    stopSystemdService.mockReset();
    stopSystemdService.mockResolvedValue(undefined);

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
    runServiceStop.mockResolvedValue(undefined);
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
    signalVerifiedGatewayPidSync.mockImplementation(() => {});
    writeGatewayRestartIntentSync.mockReturnValue(true);
    formatGatewayPidList.mockImplementation((pids) => pids.join(", "));
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

  it("repairs toward an explicitly configured gateway port", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    resolveGatewayPort.mockReturnValue(19_001);

    await runDaemonStart({ json: true });
    await runDaemonRestart({ json: true });

    expect(requireMockCallArg(runServiceStart, "runServiceStart").expectedPort).toBe(19_001);
    expect(requireMockCallArg(runServiceRestart, "runServiceRestart").expectedPort).toBe(19_001);
  });

  it("requests a safe gateway restart over RPC without touching the service manager", async () => {
    await runDaemonRestart({ json: true, safe: true });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: { reason: "gateway.restart.safe" },
      timeoutMs: 10_000,
    });
    expect(runServiceRestart).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "safe-rpc",
      mode: "deferred",
      pid: 123,
    });
  });

  it("keeps force restart on the existing non-safe path", async () => {
    await runDaemonRestart({ json: true, force: true });

    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(runServiceRestart).toHaveBeenCalledTimes(1);
  });

  it("forwards --safe --skip-deferral as skipDeferral: true on the RPC", async () => {
    await runDaemonRestart({ json: true, safe: true, skipDeferral: true });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: { reason: "gateway.restart.safe", skipDeferral: true },
      timeoutMs: 10_000,
    });
    expect(runServiceRestart).not.toHaveBeenCalled();
  });

  it("rejects --skip-deferral without --safe", async () => {
    await expect(runDaemonRestart({ json: true, skipDeferral: true })).rejects.toThrow(
      "--skip-deferral requires --safe",
    );
    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(runServiceRestart).not.toHaveBeenCalled();
  });

  it("repairs stale loaded service definitions from gateway start", async () => {
    repairLoadedGatewayServiceForStart.mockResolvedValue({
      result: "started",
      message: "Gateway service definition repaired and started.",
      loaded: true,
    });
    runServiceStart.mockImplementation(
      async (params: {
        repairLoadedService?: (args: {
          json: boolean;
          stdout: NodeJS.WritableStream;
          state: unknown;
          issues: unknown[];
        }) => Promise<unknown>;
      }) => {
        await params.repairLoadedService?.({
          json: true,
          stdout: process.stdout,
          state: { command: { environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" } } },
          issues: [{ code: "version-mismatch", message: "old service" }],
        });
      },
    );

    await runDaemonStart({ json: true });

    const repairParams = requireMockCallArg(
      repairLoadedGatewayServiceForStart,
      "repairLoadedGatewayServiceForStart",
    ) as {
      service?: unknown;
      json?: unknown;
      state?: { command?: { environment?: unknown } };
      issues?: Array<{ code?: unknown }>;
    };
    expect(repairParams.service).toBe(service);
    expect(repairParams.json).toBe(true);
    expect(repairParams.state?.command?.environment).toEqual({
      OPENCLAW_SERVICE_VERSION: "2026.4.24",
    });
    expect(repairParams.issues).toHaveLength(1);
    expect(repairParams.issues?.[0]?.code).toBe("version-mismatch");
  });

  it("kills stale gateway pids and retries restart", async () => {
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [1993],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    const healthy: RestartHealthSnapshot = {
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy).mockResolvedValueOnce(healthy);
    terminateStaleGatewayPids.mockResolvedValue([1993]);

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(terminateStaleGatewayPids).toHaveBeenCalledWith([1993]);
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(2);
  });

  it("skips stale-pid retry health checks when the retry restart is only scheduled", async () => {
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [1993],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy);
    terminateStaleGatewayPids.mockResolvedValue([1993]);
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(terminateStaleGatewayPids).toHaveBeenCalledWith([1993]);
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
  });

  it("fails restart when gateway remains unhealthy after the full timeout", async () => {
    const { formatCliCommand } = await import("../command-format.js");
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };
    waitForGatewayHealthyRestart.mockResolvedValue(unhealthy);

    const error = await expectRestartError(runDaemonRestart({ json: true }));
    expect(error.message).toBe("Gateway restart timed out after 60s waiting for health checks.");
    expect(error.hints).toEqual([
      formatCliCommand("openclaw gateway status --deep"),
      formatCliCommand("openclaw doctor"),
    ]);
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(renderRestartDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("reports the extended migration-aware timeout duration", async () => {
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: "running", pid: 4242 },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
      waitOutcome: "timeout",
      elapsedMs: 360_000,
    });

    const error = await expectRestartError(runDaemonRestart({ json: true }));
    expect(error.message).toBe("Gateway restart timed out after 360s waiting for health checks.");
  });

  it("waits longer for Windows gateway restart health", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    await runDaemonRestart({ json: true });

    const waitParams = requireMockCallArg(
      waitForGatewayHealthyRestart,
      "waitForGatewayHealthyRestart",
    ) as {
      attempts?: unknown;
      delayMs?: unknown;
      includeUnknownListenersAsStale?: unknown;
      port?: unknown;
    };
    expect(waitParams.attempts).toBe(360);
    expect(waitParams.delayMs).toBe(500);
    expect(waitParams.includeUnknownListenersAsStale).toBe(true);
    expect(waitParams.port).toBe(18789);
  });

  it("fails restart with a stopped-free message when the waiter exits early", async () => {
    const { formatCliCommand } = await import("../command-format.js");
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
      waitOutcome: "stopped-free",
      elapsedMs: 12_500,
    };
    waitForGatewayHealthyRestart.mockResolvedValue(unhealthy);

    const error = await expectRestartError(runDaemonRestart({ json: true }));
    expect(error.message).toBe(
      "Gateway restart failed after 13s: service stayed stopped and health checks never came up.",
    );
    expect(error.hints).toEqual([
      formatCliCommand("openclaw gateway status --deep"),
      formatCliCommand("openclaw doctor"),
    ]);
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(renderRestartDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("signals an unmanaged gateway process on stop", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200, 4200, 4300]);
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await runDaemonStop({ json: true });

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4300, "SIGTERM");
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid: 4200,
    });
  });

  it("blocks non-interactive stop without force before managed service access", async () => {
    isTerminalInteractive.mockReturnValue(false);
    const { defaultRuntime } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    await expect(runDaemonStop({ json: true })).rejects.toThrow(
      'process.exit unexpectedly called with "1"',
    );

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("openclaw gateway run --dev"),
      }),
    );
    expect(runServiceStop).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("allows a forced non-interactive managed stop", async () => {
    isTerminalInteractive.mockReturnValue(false);

    await runDaemonStop({ json: true, force: true });

    expect(runServiceStop).toHaveBeenCalledTimes(1);
  });

  it("allows forced non-interactive unmanaged stop fallback", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await runDaemonStop({ json: true, force: true });

    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
  });

  it("routes macOS disable stops through the service manager when not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonStop({ json: true, disable: true });

    const stopParams = requireMockCallArg(runServiceStop, "runServiceStop") as {
      opts?: unknown;
      stopWhenNotLoaded?: unknown;
    };
    expect(stopParams.opts).toEqual({ json: true, disable: true });
    expect(stopParams.stopWhenNotLoaded).toBe(true);
  });

  it("stops a running disabled systemd unit through the service manager", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await runDaemonStop({ json: true });

    expect(service.stop).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env, stdout: process.stdout }),
    );
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("skips gateway port resolution on stop when the service manager handles the stop", async () => {
    await runDaemonStop({ json: true });

    expect(service.readCommand).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(resolveGatewayPort).not.toHaveBeenCalled();
  });

  it("signals a single unmanaged gateway process on restart", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGUSR1");
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "cli",
      mode: "sigusr1",
      pid: 4200,
    });
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("uses targeted RPC for an unmanaged Windows gateway restart", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart",
        target: {
          pid: 4200,
          ownerId: "gateway-owner-old",
          port: 18_789,
        },
      },
      localPortOverride: 18_789,
      ignoreEnvUrlOverride: true,
      timeoutMs: 10_000,
    });
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
      port: 18_789,
      attempts: 960,
      delayMs: 500,
      previousLockIdentity: {
        pid: 4200,
        ownerId: "gateway-owner-old",
        createdAt: "2026-07-16T12:00:00.000Z",
        port: 18_789,
      },
      waitIndefinitelyForPreviousOwner: false,
    });
  });

  it("uses the legacy local RPC contract for a pre-upgrade Windows gateway lock", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4200,
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true, wait: "30s" });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart",
        skipDeferral: true,
      },
      localPortOverride: 18_789,
      ignoreEnvUrlOverride: true,
      timeoutMs: 10_000,
    });
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 4200,
      reason: "gateway.restart",
      intent: { waitMs: 30_000 },
    });
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
      port: 18_789,
      attempts: 420,
      delayMs: 500,
      previousLockIdentity: {
        pid: 4200,
        createdAt: "2026-07-16T12:00:00.000Z",
        port: 18_789,
      },
      waitIndefinitelyForPreviousOwner: false,
    });
  });

  it("signals and verifies the active unmanaged port despite a config edit", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    readActiveGatewayLockPort.mockResolvedValue(18_789);
    findVerifiedGatewayListenerPidsOnPortSync.mockImplementation((port) =>
      port === 18_789 ? [4200] : [],
    );
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18_789);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGUSR1");
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18_789 }),
    );
  });

  it("prefers launchd repair over unmanaged restart when an installed LaunchAgent is unloaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockResolvedValue({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result: "restarted" });
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to unmanaged restart when launchd repair reports headless GUI bootstrap failure", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockRejectedValue(
      new Error("LaunchAgent openclaw gateway restart requires a logged-in macOS GUI session"),
    );
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow("logged-in macOS GUI session");

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
  });

  it("re-bootstraps an installed LaunchAgent on restart when no unmanaged listener exists", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockResolvedValue({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        await params.postRestartCheck?.({
          json: Boolean(params.opts?.json),
          stdout: process.stdout,
          warnings: [],
          fail: (message: string) => {
            throw new Error(message);
          },
        });
        return true;
      },
    );

    await runDaemonRestart({ json: true });

    expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result: "restarted" });
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200, 4300]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "multiple gateway processes are listening on port 18789",
    );
  });

  it("fails unmanaged restart when the running gateway has commands.restart disabled", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: false } },
    });
    isRestartEnabled.mockReturnValue(false);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
    );
  });

  it("delegates system-scope restart to systemctl without unmanaged signaling when root (openclaw#87577)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
    });
    restartSystemdService.mockResolvedValue({ outcome: "completed" });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).resolves.toBe(true);

    expect(restartSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("surfaces systemd sudo guidance and never signals when restarting a system-scope unit as non-root (openclaw#87577)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
    });
    restartSystemdService.mockRejectedValue(
      new Error(
        "openclaw.service is a system-scope unit (/etc/systemd/system/openclaw.service); run `sudo systemctl restart openclaw.service` to restart it",
      ),
    );
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      /sudo systemctl restart openclaw\.service/,
    );

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("delegates system-scope stop to systemctl without unmanaged signaling when root (openclaw#87577)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    stopSystemdService.mockResolvedValue(undefined);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await expect(runDaemonStop({ json: true })).resolves.toBeUndefined();
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("surfaces systemd sudo guidance and never signals when stopping a system-scope unit as non-root (openclaw#87577)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    stopSystemdService.mockRejectedValue(
      new Error(
        "openclaw-gateway.service is a system-scope unit (/etc/systemd/system/openclaw-gateway.service); run `sudo systemctl stop openclaw-gateway.service` to stop it",
      ),
    );
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await expect(runDaemonStop({ json: true })).rejects.toThrow(
      /sudo systemctl stop openclaw-gateway\.service/,
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("skips unmanaged signaling for pids that are not live gateway processes", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );

    await runDaemonStop({ json: true });

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });
});
