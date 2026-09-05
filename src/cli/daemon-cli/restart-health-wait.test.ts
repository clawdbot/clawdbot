// Managed gateway restart polling tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  callGateway,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
  waitForStoppedFreeGatewayRestart,
} from "./restart-health.test-helpers.js";

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each([
    {
      name: "waits for consecutive healthy probes",
      pids: [8000, 8000, 8000],
      reachable: [true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 1_000,
    },
    {
      name: "restarts settling after an unhealthy probe",
      pids: [8000, 8000, 8000, 8000, 8000, 8000],
      reachable: [true, true, false, true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 2_500,
    },
    {
      name: "restarts settling when the healthy process changes",
      pids: [8000, 8000, 9000, 9000, 9000],
      reachable: [true, true, true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 2_000,
    },
    {
      name: "keeps the full settle window after the standard readiness deadline",
      pids: [8000, 8000, 8000, 8000, 8000],
      reachable: [false, false, true, true, true],
      attempts: 2,
      outcome: "healthy",
      elapsedMs: 2_000,
    },
    {
      name: "does not report an unsettled healthy snapshot as recovered at timeout",
      pids: [8000, 8000, 8000, 8000, 8000],
      reachable: [false, false, false, true, true],
      attempts: 2,
      outcome: "timeout",
      elapsedMs: 2_000,
    },
    ...(["linux", "darwin"] as const).map((platform) => ({
      name: `times out without a runtime PID on ${platform}`,
      platform,
      pids: [undefined, undefined, undefined, undefined, undefined],
      reachable: [true, true, true, true, true],
      attempts: 2,
      outcome: "timeout",
      elapsedMs: 2_000,
    })),
    {
      name: "settles without a runtime PID on win32",
      platform: "win32",
      pids: [undefined, undefined, undefined],
      reachable: [true, true, true],
      attempts: 2,
      outcome: "healthy",
      elapsedMs: 1_000,
    },
  ])("$name", async ({ platform, pids, reachable, attempts, outcome, elapsedMs }) => {
    if (platform) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
    const service = makeGatewayService({ status: "running", pid: 8000 });
    for (const pid of pids) {
      vi.mocked(service.readRuntime).mockResolvedValueOnce({ status: "running", pid });
    }
    for (const ok of reachable) {
      if (ok) {
        callGateway.mockImplementationOnce(
          gatewayHealthResponse({ server: { version: "2026.8.1" } }),
        );
      } else {
        callGateway.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      }
    }
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000 }, { pid: 9000 }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedVersion: "2026.8.1",
      requireRunningService: true,
      attempts,
      delayMs: 500,
      settle: { probes: 3 },
    });

    expect(snapshot.waitOutcome).toBe(outcome);
    expect(snapshot.healthy).toBe(outcome === "healthy");
    expect(snapshot.runtime.pid).toBe(pids.at(-1));
    expect(snapshot.elapsedMs).toBe(elapsedMs);
    expect(callGateway).toHaveBeenCalledTimes(reachable.length);
  });

  it("waits for the managed service when running service proof is required", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
      }),
    );
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
      service: { readRuntime, readCommand: vi.fn(async () => null) } as unknown as GatewayService,
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
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "stale" },
      }),
    );
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

  it("keeps waiting while a launchd KeepAlive supervisor can retry", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart({ supervisorKeepsAlive: true });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(60_000);
    expect(sleep).toHaveBeenCalledTimes(120);
  });

  it("accepts a launchd KeepAlive restart after the stopped-free grace window", async () => {
    let runtimeReads = 0;
    let portInspections = 0;
    const service = {
      readRuntime: vi.fn(async () =>
        ++runtimeReads >= 27 ? { status: "running", pid: 8000 } : { status: "stopped" },
      ),
      readCommand: vi.fn(async () => null),
    } as unknown as GatewayService;
    inspectPortUsage.mockImplementation(async () =>
      ++portInspections >= 27
        ? {
            port: 18789,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          }
        : { port: 18789, status: "free", listeners: [], hints: [] },
    );
    callGateway.mockImplementation(gatewayHealthResponse({}));

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 120,
      delayMs: 500,
      supervisorKeepsAlive: true,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(13_000);
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
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.26", connId: "new" },
      }),
    );

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

  it("keeps waiting when the expected gateway build identity is not available yet", async () => {
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
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.26", buildId: "new-build", connId: "new" },
      }),
    );

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayBuildId).toBe("new-build");
    expect(snapshot.expectedBuildId).toBe("new-build");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.buildIdMismatch).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting when the gateway probe cannot report build identity yet", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    callGateway.mockRejectedValueOnce(new Error("connect ECONNREFUSED")).mockImplementationOnce(
      gatewayHealthResponse({
        server: { version: "2026.4.26", buildId: "new-build", connId: "new" },
      }),
    );

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayBuildId).toBe("new-build");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.buildIdMismatch).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails closed when build identity remains unavailable through the wait deadline", async () => {
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
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(4_000);
    expect(snapshot.buildIdMismatch).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("fails immediately when a reachable gateway omits build identity", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.26", connId: "legacy" },
      }),
    );

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("build-id-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.buildIdMismatch).toEqual({ expected: "new-build", actual: null });
    expect(sleep).not.toHaveBeenCalled();
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
