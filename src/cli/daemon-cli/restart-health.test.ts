// Managed gateway restart inspection tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import {
  classifyPortListener,
  createConfigIO,
  firstCallArg,
  inspectAmbiguousOwnershipWithProbe,
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  inspectUnknownListenerFallback,
  makeGatewayService,
  probeGateway,
  readBestEffortConfig,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

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
    "repair required",
    "device identity required",
    "connect challenge missing nonce",
    "device signature invalid",
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
});
