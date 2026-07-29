import { vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { PortUsage } from "../../infra/ports.js";

type PortListenerKind = ReturnType<typeof import("../../infra/ports.js").classifyPortListener>;

export const inspectPortUsage = vi.fn<(port: number) => Promise<PortUsage>>();
export const monotonicClock = { nowMs: 0 };
export const sleep = vi.fn(async (ms: number) => {
  monotonicClock.nowMs += ms;
});
export const classifyPortListener = vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(
  () => "gateway",
);
export const probeGateway = vi.fn();
export const createConfigIO = vi.fn();
export const readBestEffortConfig = vi.fn(async () => ({}));
export const resolveGatewayProbeAuthSafeWithSecretInputs = vi.fn<
  (_opts: unknown) => Promise<{ auth: { token?: string; password?: string } }>
>(async () => ({ auth: {} }));
const hasActiveStartupMigrationLease = vi.fn<(_params?: unknown) => boolean>(() => false);
export const readActiveGatewayLockIdentity = vi.fn();

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

vi.mock("../../infra/gateway-lock.js", () => ({
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

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleep(ms),
  };
});

const originalPlatform = process.platform;

export function makeGatewayService(
  runtime: { status: "running"; pid: number } | { status: "stopped" },
): GatewayService {
  return {
    readRuntime: vi.fn(async () => runtime),
  } as unknown as GatewayService;
}

export function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

const previousGatewayLockIdentity: GatewayLockIdentity = {
  pid: 4200,
  ownerId: "gateway-owner-old",
  createdAt: "2026-07-16T12:00:00.000Z",
  port: 18789,
};

export function mockGatewayLockReplacement(overrides: Partial<GatewayLockIdentity> = {}) {
  const previousLockIdentity = { ...previousGatewayLockIdentity };
  readActiveGatewayLockIdentity.mockResolvedValueOnce(previousLockIdentity).mockResolvedValue({
    ...previousLockIdentity,
    ownerId: "gateway-owner-new",
    createdAt: "2026-07-16T12:00:01.000Z",
    ...overrides,
  });
  return previousLockIdentity;
}

export async function inspectGatewayRestartWithSnapshot(params: {
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

export async function inspectUnknownListenerFallback(params: {
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

export async function inspectAmbiguousOwnershipWithProbe(
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

export async function waitForStoppedFreeGatewayRestart(
  params: {
    supervisorKeepsAlive?: boolean;
  } = {},
) {
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
    supervisorKeepsAlive: params.supervisorKeepsAlive,
  });
}

export function resetRestartHealthMocks() {
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
  readActiveGatewayLockIdentity.mockReset();
  readActiveGatewayLockIdentity.mockResolvedValue(undefined);
}

export function restoreRestartHealthMocks() {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}
