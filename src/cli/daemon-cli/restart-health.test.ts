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

    expect(snapshot).toMatchObject({
      healthy: false,
      gatewayVersion: "2026.4.23",
      expectedVersion: "2026.4.24",
      versionMismatch: {
        expected: "2026.4.24",
        actual: "2026.4.23",
      },
    });
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

    expect(snapshot).toMatchObject({
      healthy: true,
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
    });
    expect(snapshot.versionMismatch).toBeUndefined();
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

    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "version-mismatch",
      elapsedMs: 0,
      versionMismatch: {
        expected: "2026.4.24",
        actual: "2026.4.23",
      },
    });
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
              error: "failed to install bundled runtime deps: ENOSPC",
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

    expect(snapshot).toMatchObject({
      healthy: false,
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
      activatedPluginErrors: [
        {
          id: "telegram",
          origin: "bundled",
          activated: true,
          error: "failed to install bundled runtime deps: ENOSPC",
        },
      ],
    });
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(probeGateway).toHaveBeenCalledWith(expect.objectContaining({ includeDetails: true }));

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
      "Activated plugin load errors:\n- telegram: failed to install bundled runtime deps: ENOSPC",
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
              error: "failed to install bundled runtime deps: ENOSPC",
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

    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "plugin-errors",
      elapsedMs: 0,
      activatedPluginErrors: [expect.objectContaining({ id: "telegram" })],
    });
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

    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "channel-errors",
      elapsedMs: 0,
      channelProbeErrors: [{ id: "telegram", error: "This operation was aborted" }],
    });
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

    expect(snapshot).toMatchObject({
      healthy: true,
      gatewayVersion: "2026.4.26",
      expectedVersion: "2026.4.26",
      waitOutcome: "healthy",
      elapsedMs: 1_000,
    });
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
