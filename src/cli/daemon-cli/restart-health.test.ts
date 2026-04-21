import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { PortListenerKind, PortUsage } from "../../infra/ports.js";

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const sleep = vi.hoisted(() => vi.fn(async (_ms: number) => {}));
const classifyPortListener = vi.hoisted(() =>
  vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(() => "gateway"),
);
const probeGateway = vi.hoisted(() => vi.fn());

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
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

async function inspectGatewayRestartWithSnapshot(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  portUsage: PortUsage;
  includeUnknownListenersAsStale?: boolean;
}) {
  const service = makeGatewayService(params.runtime);
  inspectPortUsage.mockResolvedValue(params.portUsage);
  const { inspectGatewayRestart } = await import("./restart-health.js");
  return inspectGatewayRestart({
    service,
    port: 18789,
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
    inspectPortUsage.mockReset();
    inspectPortUsage.mockResolvedValue({
      port: 0,
      status: "free",
      listeners: [],
      hints: [],
    });
    sleep.mockReset();
    classifyPortListener.mockReset();
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockReset();
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
    });
  });

  afterEach(() => {
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
    expect(snapshot.staleGatewayPids).toEqual([]);
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

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not apply unknown-listener fallback while runtime is running", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "running", pid: 10920 },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not treat known non-gateway listeners as stale in fallback mode", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    classifyPortListener.mockReturnValue("ssh");

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "stopped" },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 22001, command: "nginx.exe" }],
        hints: [],
      },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("uses a local gateway probe when ownership is ambiguous", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe({
      ok: true,
      close: null,
    });

    expect(snapshot.healthy).toBe(true);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
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
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("treats auth-closed probe as healthy gateway reachability", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe({
      ok: false,
      close: { code: 1008, reason: "auth required" },
    });

    expect(snapshot.healthy).toBe(true);
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
    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot).toMatchObject({
      healthy: false,
      runtime: { status: "stopped" },
      portUsage: { status: "free" },
      waitOutcome: "stopped-free",
      elapsedMs: 12_500,
    });
    expect(sleep).toHaveBeenCalledTimes(25);
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot).toMatchObject({
      healthy: false,
      runtime: { status: "stopped" },
      portUsage: { status: "free" },
      waitOutcome: "stopped-free",
      elapsedMs: 92_500,
    });
    expect(sleep).toHaveBeenCalledTimes(185);
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

    expect(snapshot).toMatchObject({
      healthy: false,
      runtime: { status: "running", pid: 8000 },
      portUsage: { status: "free" },
      waitOutcome: "timeout",
      elapsedMs: 4_000,
    });
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
