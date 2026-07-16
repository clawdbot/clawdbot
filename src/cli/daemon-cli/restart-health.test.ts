// Daemon restart health tests cover health checks after daemon restart operations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { PortUsage } from "../../infra/ports.js";

type PortListenerKind = ReturnType<typeof import("../../infra/ports.js").classifyPortListener>;

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const monotonicClock = vi.hoisted(() => ({ nowMs: 0 }));
const sleep = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    monotonicClock.nowMs += ms;
  }),
);
const classifyPortListener = vi.hoisted(() =>
  vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(() => "gateway"),
);
const probeGateway = vi.hoisted(() => vi.fn());
const createConfigIO = vi.hoisted(() => vi.fn());
const readBestEffortConfig = vi.hoisted(() => vi.fn(async () => ({})));
const resolveGatewayProbeAuthSafeWithSecretInputs = vi.hoisted(() =>
  vi.fn<(_opts: unknown) => Promise<{ auth: { token?: string; password?: string } }>>(async () => ({
    auth: {},
  })),
);
const hasActiveStartupMigrationLease = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => boolean>(() => false),
);

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../../config/io.js", () => ({
  createConfigIO: (opts: unknown) => createConfigIO(opts),
}));

vi.mock("../../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: (opts: unknown) =>
    resolveGatewayProbeAuthSafeWithSecretInputs(opts),
}));

vi.mock("../../infra/startup-migration-checkpoint.js", () => ({
  hasActiveStartupMigrationLease: (params: unknown) => hasActiveStartupMigrationLease(params),
  STARTUP_MIGRATION_LEASE_TTL_MS: 5 * 60_000,
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleep(ms),
  };
});

const originalPlatform = process.platform;

function makeGatewayService(
  runtime: { status: "running"; pid: number } | { status: "stopped" },
): GatewayService {
  return {
    readRuntime: vi.fn(async () => runtime),
  } as unknown as GatewayService;
}

function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

async function inspectGatewayRestartWithSnapshot(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  portUsage: PortUsage;
  expectedVersion?: string;
  includeUnknownListenersAsStale?: boolean;
}) {
  const service = makeGatewayService(params.runtime);
  inspectPortUsage.mockResolvedValue(params.portUsage);
  const { inspectGatewayRestart } = await import("./restart-health.js");
  return inspectGatewayRestart({
    service,
    port: 18789,
    ...(params.expectedVersion === undefined ? {} : { expectedVersion: params.expectedVersion }),
    ...(params.includeUnknownListenersAsStale === undefined
      ? {}
      : { includeUnknownListenersAsStale: params.includeUnknownListenersAsStale }),
  });
}

async function inspectUnknownListenerFallback(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  includeUnknownListenersAsStale: boolean;
}) {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  classifyPortListener.mockReturnValue("unknown");
  return inspectGatewayRestartWithSnapshot({
    runtime: params.runtime,
    portUsage: {
      port: 18789,
      status: "busy",
      listeners: [{ pid: 10920, command: "unknown" }],
      hints: [],
    },
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
  });
}

async function inspectAmbiguousOwnershipWithProbe(
  probeResult: Awaited<ReturnType<typeof probeGateway>>,
) {
  classifyPortListener.mockReturnValue("unknown");
  probeGateway.mockResolvedValue(probeResult);
  return inspectGatewayRestartWithSnapshot({
    runtime: { status: "running", pid: 8000 },
    portUsage: {
      port: 18789,
      status: "busy",
      listeners: [{ commandLine: "" }],
      hints: [],
    },
  });
}

async function waitForStoppedFreeGatewayRestart() {
  const attempts = process.platform === "win32" ? 360 : 120;
  const service = makeGatewayService({ status: "stopped" });
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });

  const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
  return waitForGatewayHealthyRestart({
    service,
    port: 18789,
    attempts,
    delayMs: 500,
  });
}

describe("inspectGatewayRestart", () => {
  beforeEach(() => {
    monotonicClock.nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicClock.nowMs);
    inspectPortUsage.mockReset();
    readBestEffortConfig.mockReset();
    readBestEffortConfig.mockResolvedValue({});
    createConfigIO.mockReset();
    createConfigIO.mockReturnValue({
      readBestEffortConfig: () => readBestEffortConfig(),
    });
    resolveGatewayProbeAuthSafeWithSecretInputs.mockReset();
    resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({ auth: {} });
    inspectPortUsage.mockResolvedValue({
      port: 0,
      status: "free",
      listeners: [],
      hints: [],
    });
    sleep.mockReset();
    sleep.mockImplementation(async (ms: number) => {
      monotonicClock.nowMs += ms;
    });
    classifyPortListener.mockReset();
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockReset();
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
    });
    hasActiveStartupMigrationLease.mockReset();
    hasActiveStartupMigrationLease.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("treats a gateway listener child pid as healthy ownership", async () => {
    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 7000 },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 7001, ppid: 7000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toStrictEqual([]);
  });

  it("marks non-owned gateway listener pids as stale while runtime is running", async () => {
    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 9000, ppid: 8999, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.staleGatewayPids).toEqual([9000]);
  });

  it("treats unknown listeners as stale on Windows when enabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "stopped" },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([10920]);
  });

  it("does not treat unknown listeners as stale when fallback is disabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "stopped" },
      includeUnknownListenersAsStale: false,
    });

    expect(snapshot.staleGatewayPids).toStrictEqual([]);
  });

  it("does not apply unknown-listener fallback while runtime is running", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "running", pid: 10920 },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toStrictEqual([]);
  });

  it("does not treat known non-gateway listeners as stale in fallback mode", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    classifyPortListener.mockReturnValue("non_gateway");

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "stopped" },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 22001, command: "sshd.exe" }],
        hints: [],
      },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toStrictEqual([]);
  });

  it("uses a local gateway probe when ownership is ambiguous", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe({
      ok: true,
      close: null,
    });

    expect(snapshot.healthy).toBe(true);
    expect((firstCallArg(probeGateway) as { url?: string }).url).toBe("ws://127.0.0.1:18789");
  });

  it("treats a busy port as healthy when runtime status lags but the probe succeeds", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "stopped" },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 9100, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toStrictEqual([]);
  });

  it.each([
    "auth required",
    "owner auth required",
    "connect failed",
    "device required",
    "pairing required",
    "pairing required: device is asking for more scopes than currently approved",
    "unauthorized: gateway token missing (set gateway.remote.token to match gateway.auth.token)",
    "unauthorized: gateway password mismatch (set gateway.remote.password to match gateway.auth.password)",
    "unauthorized: device token rejected (pair/repair this device, or provide gateway token)",
  ])(
    "treats local policy-close probe reason %s as healthy gateway reachability",
    async (reason) => {
      const snapshot = await inspectAmbiguousOwnershipWithProbe({
        ok: false,
        close: { code: 1008, reason },
      });

      expect(snapshot.healthy).toBe(true);
    },
  );

  it.each([
    "",
    " ",
    "repair required",
    "repairing required",
    "unpairing required",
    "device",
    "device required by local spoof",
    "device required: identity missing",
    "device identity required",
    "connect challenge missing nonce",
    "connect challenge timeout",
    "authoritative policy close",
    "device identity mismatch",
    "device signature invalid",
    "device nonce required",
    "token expired",
    "password required",
    "missing scope: operator.admin",
    "role denied",
    "unauthorized: session revoked",
  ])(
    "does not treat ambiguous 1008 close reason %s as healthy gateway reachability",
    async (reason) => {
      const snapshot = await inspectAmbiguousOwnershipWithProbe({
        ok: false,
        close: { code: 1008, reason },
      });

      expect(snapshot.healthy).toBe(false);
    },
  );

  it("requires the expected gateway version when provided", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.23", connId: "old" },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.23");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.expected).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.actual).toBe("2026.4.23");
  });

  it("accepts the restarted gateway when the expected version matches", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch).toBeUndefined();
  });

  it("waits for the managed service when running service proof is required", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    const readRuntime = vi
      .fn()
      .mockResolvedValueOnce({ status: "stopped" })
      .mockResolvedValue({ status: "running", pid: 8000 });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: { readRuntime } as unknown as GatewayService,
      port: 18789,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 3,
      delayMs: 1,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.runtime.status).toBe("running");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("times out when running service proof never arrives", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "stale" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 5151, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "stopped" }),
      port: 18789,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 2,
      delayMs: 1,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits through a healthy long-running startup migration", async () => {
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () => {
      inspections += 1;
      if (inspections < 15) {
        return {
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        };
      }
      return {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      };
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(140_000);
    expect(sleep).toHaveBeenCalledTimes(14);
    expect(isStartupMigrationActive).toHaveBeenCalled();
  });

  it("keeps the readiness window after an observed migration ends near the standard deadline", async () => {
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () => {
      inspections += 1;
      return inspections < 8
        ? { port: 18789, status: "free", listeners: [], hints: [] }
        : {
            port: 18789,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          };
    });
    let migrationPolls = 0;
    const isStartupMigrationActive = vi.fn(() => {
      migrationPolls += 1;
      return migrationPolls < 7;
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(70_000);
    expect(sleep).toHaveBeenCalledTimes(7);
  });

  it("keeps the caller's full readiness window after an observed migration ends", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    let migrationPolls = 0;
    const isStartupMigrationActive = vi.fn(() => {
      migrationPolls += 1;
      return migrationPolls < 4;
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 18,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(210_000);
    expect(sleep).toHaveBeenCalledTimes(21);
  });

  it("keeps the standard timeout for a running non-migration startup failure", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const isStartupMigrationActive = vi.fn(() => false);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(60_000);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(isStartupMigrationActive).toHaveBeenCalledTimes(7);
  });

  it("bounds a startup migration that never reaches readiness", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 1,
      delayMs: 60_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(300_000);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("includes slow health inspections in the migration watchdog", async () => {
    inspectPortUsage.mockImplementation(async () => {
      monotonicClock.nowMs += 90_000;
      return {
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      };
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 1,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(390_000);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("accepts matching-version restart liveness when the probe lacks operator scope", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
      connectLatencyMs: 12,
      error: "missing scope: operator.read",
      auth: { capability: "connected_no_operator_scope" },
      server: { version: "2026.4.24", connId: "new" },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch).toBeUndefined();
  });

  it("uses configured local probe auth while waiting for a matching-version restart", async () => {
    readBestEffortConfig.mockResolvedValue({
      gateway: { auth: { mode: "token", token: "probe-token" } },
    });
    resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({
      auth: { token: "probe-token" },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
    });
    const service = makeGatewayService({ status: "running", pid: 8000 });
    const serviceEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: "/tmp/openclaw-restart-service-state",
    } as NodeJS.ProcessEnv;
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedVersion: "2026.4.24",
      attempts: 1,
      env: serviceEnv,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    const authResolveInput = firstCallArg(resolveGatewayProbeAuthSafeWithSecretInputs) as {
      cfg?: { gateway?: { auth?: { mode?: string; token?: string } } };
      mode?: string;
    };
    expect(authResolveInput.cfg?.gateway?.auth?.mode).toBe("token");
    expect(authResolveInput.cfg?.gateway?.auth?.token).toBe("probe-token");
    expect(authResolveInput.mode).toBe("local");
    expect(createConfigIO).toHaveBeenCalledWith(
      expect.objectContaining({
        env: serviceEnv,
        pluginValidation: "skip",
        suppressFutureVersionWarning: true,
      }),
    );
    const probeInput = firstCallArg(probeGateway) as {
      auth?: { token?: string; password?: string };
      env?: NodeJS.ProcessEnv;
    };
    expect(probeInput.auth?.token).toBe("probe-token");
    expect(probeInput.auth?.password).toBeUndefined();
    expect(probeInput.env).toBe(serviceEnv);
  });

  it("stops waiting once the restarted gateway reports the wrong version", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.23", connId: "old" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("version-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.versionMismatch?.expected).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.actual).toBe("2026.4.23");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("marks matching-version restarts unhealthy when activated plugins failed to load", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
            {
              id: "optional",
              origin: "workspace",
              activated: false,
              error: "disabled plugin ignored",
            },
          ],
        },
      },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.activatedPluginErrors).toEqual([
      {
        id: "telegram",
        origin: "bundled",
        activated: true,
        error: "failed to load plugin dependency: ENOSPC",
      },
    ]);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect((firstCallArg(probeGateway) as { includeDetails?: boolean }).includeDetails).toBe(true);

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
      "Activated plugin load errors:\n- telegram: failed to load plugin dependency: ENOSPC",
    );
  });

  it("stops waiting once the expected-version gateway reports activated plugin errors", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
          ],
        },
      },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("plugin-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.activatedPluginErrors?.[0]?.id).toBe("telegram");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops waiting once the expected-version gateway reports channel probe errors", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        channels: {
          telegram: {
            configured: true,
            probe: { ok: false, error: "This operation was aborted" },
          },
        },
      },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("channel-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.channelProbeErrors).toEqual([
      { id: "telegram", error: "This operation was aborted" },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats busy ports with unavailable listener details as healthy when runtime is running", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 8000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [],
      hints: [
        "Port is in use but process details are unavailable (install lsof or run as an admin user).",
      ],
      errors: ["Error: spawn lsof ENOENT"],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(true);
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("annotates stopped-free early exits with the actual elapsed time", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(snapshot.elapsedMs).toBe(12_500);
    expect(sleep).toHaveBeenCalledTimes(25);
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(snapshot.elapsedMs).toBe(92_500);
    expect(sleep).toHaveBeenCalledTimes(185);
  });

  it("keeps waiting when the expected gateway version is not available yet", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage
      .mockResolvedValueOnce({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      })
      .mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.26", connId: "new" },
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedVersion: "2026.4.26",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.26");
    expect(snapshot.expectedVersion).toBe("2026.4.26");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(1_000);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("annotates timeout waits when the health loop exhausts all attempts", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("running");
    expect(snapshot.runtime.pid).toBe(8000);
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(4_000);
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
