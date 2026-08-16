// Gateway restart probe and health-detail tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  firstCallArg,
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  makeGatewayService,
  probeGateway,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

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
});
