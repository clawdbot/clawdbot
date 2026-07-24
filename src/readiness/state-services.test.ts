import { describe, expect, it, vi } from "vitest";
import {
  DELIVERY_RUNTIME_READY_CRITERION_ID,
  SCHEDULER_READY_CRITERION_ID,
  STATE_READY_CRITERION_ID,
  createStateServiceReadinessResolver,
} from "./state-services.js";

const statePath = "/tmp/openclaw-state/state/openclaw.sqlite";

function createResolver(
  overrides: {
    state?: "active" | "failed" | "inactive";
    deliveryActive?: boolean;
  } = {},
) {
  return createStateServiceReadinessResolver({
    getStateDatabaseStatus: vi.fn(() => overrides.state ?? "inactive"),
    getDeliveryRuntime: vi.fn(() => ({
      active: overrides.deliveryActive ?? false,
      generation: 1,
    })),
  });
}

describe("state service readiness", () => {
  it("does no owner work when no state-service criteria are selected", () => {
    const getStateDatabaseStatus = vi.fn(() => "active" as const);
    const getDeliveryRuntime = vi.fn(() => ({ active: true, generation: 1 }));
    const resolve = createStateServiceReadinessResolver({
      getStateDatabaseStatus,
      getDeliveryRuntime,
    });

    expect(resolve({ criterionIds: new Set() })).toEqual([]);
    expect(getStateDatabaseStatus).not.toHaveBeenCalled();
    expect(getDeliveryRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "True", "StateDatabaseReady"],
    ["failed", "False", "StateDatabaseUnavailable"],
    ["inactive", "False", "StateDatabaseInactive"],
  ] as const)("maps the %s state database lifecycle", (state, status, reason) => {
    const resolve = createResolver({ state });

    expect(
      resolve({
        criterionIds: new Set([STATE_READY_CRITERION_ID]),
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "StateReady",
        status,
        reason,
        requirement: "advisory",
      }),
    ]);
  });

  it.each([
    [true, "True", "DeliveryRuntimeReady"],
    [false, "False", "DeliveryRuntimeInactive"],
  ] as const)("maps delivery runtime active=%s", (active, status, reason) => {
    const resolve = createResolver({ deliveryActive: active });

    expect(resolve({ criterionIds: new Set([DELIVERY_RUNTIME_READY_CRITERION_ID]) })).toEqual([
      expect.objectContaining({ type: "DeliveryRuntimeReady", status, reason }),
    ]);
  });

  it.each([
    [false, "disabled", false, "True", "SchedulerNotConfigured"],
    [true, "idle", false, "False", "SchedulerNotStarted"],
    [true, "starting", false, "False", "SchedulerStarting"],
    [true, "started", false, "True", "SchedulerReady"],
    [true, "paused", false, "False", "SchedulerPaused"],
    [true, "stopped", false, "False", "SchedulerStopped"],
    [true, "started", true, "False", "SchedulerRecoveryPending"],
  ] as const)(
    "maps scheduler enabled=%s phase=%s recovery=%s",
    (enabled, phase, recoveryPending, status, reason) => {
      const resolve = createResolver();

      expect(
        resolve({
          criterionIds: new Set([SCHEDULER_READY_CRITERION_ID]),
          snapshot: { scheduler: { enabled, phase, recoveryPending } },
        }),
      ).toEqual([expect.objectContaining({ type: "SchedulerReady", status, reason })]);
    },
  );

  it("reports unavailable scheduler evidence as unknown", () => {
    const resolve = createResolver();

    expect(resolve({ criterionIds: new Set([SCHEDULER_READY_CRITERION_ID]) })).toEqual([
      expect.objectContaining({
        type: "SchedulerReady",
        status: "Unknown",
        reason: "SchedulerStatusUnavailable",
      }),
    ]);
  });

  it("redacts unexpected owner errors", () => {
    const resolve = createStateServiceReadinessResolver({
      getStateDatabaseStatus: vi.fn(() => {
        throw new Error(`cannot inspect ${statePath}`);
      }),
      getDeliveryRuntime: vi.fn(() => ({ active: false, generation: 0 })),
    });

    expect(resolve({ criterionIds: new Set([STATE_READY_CRITERION_ID]) })).toEqual([
      expect.objectContaining({
        type: "StateReady",
        status: "Unknown",
        reason: "CriterionEvaluationFailed",
      }),
    ]);
  });
});
