import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
};

const runServiceStart = vi.fn();
const runServiceRestart = vi.fn();
const runServiceStop = vi.fn();
const runServiceUninstall = vi.fn();
const waitForGatewayHealthyListener = vi.fn();
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18_789));
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const readActiveGatewayLockPort = vi.hoisted(() => vi.fn());
const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn();
const signalVerifiedGatewayPidSync = vi.fn();
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const findInstalledSystemdGatewayScope = vi.fn();
const probeGateway = vi.fn();
const callGatewayCli = vi.fn();
const isTerminalInteractive = vi.fn(() => true);
const appendGatewayLifecycleAudit = vi.fn();
const createGatewayLifecycleMutationAudit = vi.fn(() => vi.fn());

const gatewayLockIdentity = {
  pid: 4200,
  ownerId: "gateway-owner-old",
  createdAt: "2026-07-16T12:00:00.000Z",
  port: 18_789,
};

vi.mock("../../config/config.js", () => ({
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
  signalVerifiedGatewayPidSync: (pid: number, signal: "SIGTERM" | "SIGUSR1") =>
    signalVerifiedGatewayPidSync(pid, signal),
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/gateway-lock.js")>();
  return {
    ...actual,
    readActiveGatewayLockPort: () => readActiveGatewayLockPort(),
    readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  };
});

vi.mock("../../infra/restart-intent.js", () => ({
  writeGatewayRestartIntentSync: (params: unknown) => writeGatewayRestartIntentSync(params),
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../../gateway/call.js", () => ({
  callGatewayCli: (opts: unknown) => callGatewayCli(opts),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: () => findInstalledSystemdGatewayScope(),
  restartSystemdService: vi.fn(),
  stopSystemdService: vi.fn(),
}));

vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart: vi.fn(),
  renderGatewayPortHealthDiagnostics: vi.fn(() => []),
  renderRestartDiagnostics: vi.fn(() => []),
  terminateStaleGatewayPids: vi.fn(),
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceStart,
  runServiceRestart,
  runServiceStop,
  runServiceUninstall,
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE: "non-interactive gateway stop requires --force",
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: () => createGatewayLifecycleMutationAudit(),
}));

async function expectRestartError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected restart to fail");
}

describe("external gateway supervision lifecycle", () => {
  let runDaemonStart: (opts?: { json?: boolean }) => Promise<void>;
  let runDaemonRestart: (opts?: {
    json?: boolean;
    force?: boolean;
    safe?: boolean;
    skipDeferral?: boolean;
    wait?: string;
  }) => Promise<boolean>;
  let runDaemonStop: (opts?: { json?: boolean }) => Promise<void>;
  let runDaemonUninstall: (opts?: { json?: boolean }) => Promise<void>;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ runDaemonStart, runDaemonRestart, runDaemonStop, runDaemonUninstall } =
      await import("./lifecycle.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_SUPERVISOR_MODE"]);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";

    for (const mock of [
      service.readCommand,
      service.readRuntime,
      service.restart,
      service.stop,
      runServiceStart,
      runServiceRestart,
      runServiceStop,
      runServiceUninstall,
      waitForGatewayHealthyListener,
      resolveGatewayPort,
      loadConfig,
      readActiveGatewayLockPort,
      readActiveGatewayLockIdentity,
      findVerifiedGatewayListenerPidsOnPortSync,
      signalVerifiedGatewayPidSync,
      writeGatewayRestartIntentSync,
      clearGatewayRestartIntentSync,
      findInstalledSystemdGatewayScope,
      probeGateway,
      callGatewayCli,
      isTerminalInteractive,
      appendGatewayLifecycleAudit,
      createGatewayLifecycleMutationAudit,
    ]) {
      mock.mockReset();
    }

    resolveGatewayPort.mockReturnValue(18_789);
    loadConfig.mockReturnValue({});
    readActiveGatewayLockPort.mockResolvedValue(18_789);
    readActiveGatewayLockIdentity.mockResolvedValue(gatewayLockIdentity);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    writeGatewayRestartIntentSync.mockReturnValue(true);
    findInstalledSystemdGatewayScope.mockResolvedValue(null);
    waitForGatewayHealthyListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18_789, status: "busy", listeners: [], hints: [] },
    });
    callGatewayCli.mockResolvedValue({ ok: true, status: "emitted", pid: 4200 });
    isTerminalInteractive.mockReturnValue(true);
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  async function expectExternalRestartFailure(message: string) {
    const { defaultRuntime } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    await expectRestartError(runDaemonRestart({ json: true }));

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "restart",
        ok: false,
        error: expect.stringContaining(message),
      }),
    );
  }

  it("restarts through the exact running Gateway without candidate state access", async () => {
    const lockIdentity = { ...gatewayLockIdentity, port: 19_455 };
    readActiveGatewayLockPort.mockResolvedValue(19_455);
    readActiveGatewayLockIdentity.mockResolvedValue(lockIdentity);

    await expect(runDaemonRestart({ json: true, force: true })).resolves.toBe(true);

    expect(runServiceRestart).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(findInstalledSystemdGatewayScope).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart",
        target: {
          pid: 4200,
          ownerId: "gateway-owner-old",
          port: 19_455,
        },
        restartIntent: { force: true },
      },
      localPortOverride: 19_455,
      ignoreEnvUrlOverride: true,
      timeoutMs: 10_000,
    });
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "supervisor",
      mode: "rpc",
      pid: 4200,
    });
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
      port: 19_455,
      attempts: 120,
      delayMs: 500,
      previousLockIdentity: lockIdentity,
      waitIndefinitelyForPreviousOwner: false,
    });
  });

  it("preserves wait intent through the running Gateway", async () => {
    await runDaemonRestart({ json: true, wait: "30s" });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart",
        target: {
          pid: 4200,
          ownerId: "gateway-owner-old",
          port: 18_789,
        },
        restartIntent: { waitMs: 30_000 },
      },
      localPortOverride: 18_789,
      ignoreEnvUrlOverride: true,
      timeoutMs: 10_000,
    });
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
      port: 18_789,
      attempts: 180,
      delayMs: 500,
      previousLockIdentity: gatewayLockIdentity,
      waitIndefinitelyForPreviousOwner: false,
    });
  });

  it("uses the same targeted in-gateway transport on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await runDaemonRestart({ json: true, wait: "30s" });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart",
        target: {
          pid: 4200,
          ownerId: "gateway-owner-old",
          port: 18_789,
        },
        restartIntent: { waitMs: 30_000 },
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
      attempts: 420,
      delayMs: 500,
      previousLockIdentity: gatewayLockIdentity,
      waitIndefinitelyForPreviousOwner: false,
    });
  });

  it("keeps safe restarts on the exact local lock owner", async () => {
    callGatewayCli.mockResolvedValue({
      ok: true,
      status: "scheduled",
      preflight: { safe: false, summary: "restart deferred", blockers: [] },
      restart: { pid: 4200 },
    });

    await runDaemonRestart({ json: true, safe: true, skipDeferral: true });

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: {
        reason: "gateway.restart.safe",
        safe: true,
        skipDeferral: true,
        target: {
          pid: 4200,
          ownerId: "gateway-owner-old",
          port: 18_789,
        },
      },
      ignoreEnvUrlOverride: true,
      localPortOverride: 18_789,
      requiredCapabilities: ["gateway-restart-target-safe-v1"],
      timeoutMs: 10_000,
    });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("refuses a restart when the lock owner does not match the listener", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue({
      ...gatewayLockIdentity,
      pid: 4300,
      ownerId: "gateway-owner-other",
    });

    await expectExternalRestartFailure("gateway lock identity does not match");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
  });

  it("does not touch state when lock ownership changes before delivery", async () => {
    readActiveGatewayLockIdentity
      .mockResolvedValueOnce(gatewayLockIdentity)
      .mockResolvedValueOnce(gatewayLockIdentity)
      .mockResolvedValue({
        ...gatewayLockIdentity,
        pid: 4300,
        ownerId: "gateway-owner-new",
        createdAt: "2026-07-16T12:00:01.000Z",
      });

    await expectExternalRestartFailure("gateway lock owner changed");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("does not fall back when targeted restart delivery fails", async () => {
    callGatewayCli.mockRejectedValue(new Error("connection closed"));

    await expectExternalRestartFailure("connection closed");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
  });

  it("rejects a legacy generic restart acknowledgement", async () => {
    callGatewayCli.mockResolvedValue({
      ok: true,
      status: "deferred",
      restart: { pid: 4200 },
    });

    await expectExternalRestartFailure("invalid restart acknowledgement");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
  });

  it("fails closed before delivery for a pre-targeted-restart Gateway lock", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4200,
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });

    await expectExternalRestartFailure("predates targeted restart ownership");

    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it.each([
    ["start", () => runDaemonStart({ json: true })],
    ["stop", () => runDaemonStop({ json: true })],
    ["uninstall", () => runDaemonUninstall({ json: true })],
  ])("blocks native %s lifecycle access", async (_action, run) => {
    await expect(run()).rejects.toThrow("gateway lifecycle is managed by an external supervisor");

    expect(runServiceStart).not.toHaveBeenCalled();
    expect(runServiceStop).not.toHaveBeenCalled();
    expect(runServiceUninstall).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
  });
});
