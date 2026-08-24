import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const { checkTelemetryUpdateMock } = vi.hoisted(() => ({
  checkTelemetryUpdateMock: vi.fn<typeof import("../infra/telemetry.js").checkTelemetryUpdate>(),
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

vi.mock("../infra/telemetry.js", () => ({
  checkTelemetryUpdate: checkTelemetryUpdateMock,
}));

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
): Promise<void> {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  await timers.stopMediaCleanup();
  timers.skillCuratorCleanup();
}

describe("gateway telemetry maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    checkTelemetryUpdateMock.mockReset();
  });

  it("uses one jittered maintenance schedule and silently retries failed checks", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    checkTelemetryUpdateMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    const logHealth = { info: vi.fn(), error: vi.fn() };
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      logHealth,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledWith({}, { surface: "gateway" });
    expect(logHealth.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(420_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("never checks telemetry for Nix-managed gateways", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const broadcast = vi.fn();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      broadcast,
      isNixMode: true,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("tick", { ts: expect.any(Number) });
    await stopMaintenanceTimers(timers);
  });
});
