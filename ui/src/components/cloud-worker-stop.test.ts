import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  resolveCloudWorkerStopAction,
  resolveCloudWorkerStopConfirmation,
} from "./cloud-worker-stop.ts";

describe("cloud worker stop action", () => {
  it("forces abandonment only for the structured retained-result recovery state", () => {
    const placement = {
      state: "failed",
      generation: 8,
      createdAtMs: 100,
      updatedAtMs: 300,
      stateChangedAtMs: 300,
      environmentId: "environment-1",
      recoveryError: "workspace recovery requires operator action",
      terminalRecovery: {
        action: "force-destroy-environment",
        dataLoss: "unreconciled-workspace-result",
      },
    } as GatewaySessionRow["placement"];

    const action = resolveCloudWorkerStopAction(placement);
    expect(action).toEqual({
      method: "environments.destroy",
      params: { environmentId: "environment-1", force: true },
      requiredScope: "operator.admin",
    });
    expect(resolveCloudWorkerStopConfirmation(action!, "Session 1")).toEqual({
      message:
        'Permanently abandon the unreconciled remote workspace changes for "Session 1" and stop its cloud worker? Those changes cannot be recovered.',
      confirmLabel: "Abandon changes and stop",
      danger: true,
    });
  });

  it("keeps ordinary failed placements on non-forced environment cleanup", () => {
    const placement = {
      state: "failed",
      generation: 8,
      createdAtMs: 100,
      updatedAtMs: 300,
      stateChangedAtMs: 300,
      environmentId: "environment-1",
      recoveryError: "provider teardown failed",
    } as GatewaySessionRow["placement"];

    expect(resolveCloudWorkerStopAction(placement)).toEqual({
      method: "environments.destroy",
      params: { environmentId: "environment-1" },
      requiredScope: "operator.admin",
    });
  });
});
