import { describe, expect, it, vi } from "vitest";
import * as support from "./service.test-support.js";

describe("worker portal RPC authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("executes portal requests only while the exact worker turn remains authorized", async () => {
    const result = { resultJson: '{"ok":true}' };
    const executeSessionTool = vi
      .fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeSessionTool"]>>()
      .mockResolvedValue(result);
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-portal-authority",
      "session-portal-authority",
      { executeSessionTool },
    );
    const request = { toolCallId: "portal-call", action: "open" as const, port: 3000 };

    await expect(workerService.executeSessionTool(identity, "portal", request)).resolves.toEqual({
      ok: true,
      result,
    });
    expect(executeSessionTool).toHaveBeenCalledWith({ identity, toolName: "portal", request });

    placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
    await expect(workerService.executeSessionTool(identity, "portal", request)).resolves.toEqual({
      ok: false,
      closeReason: "method-not-allowed",
    });
    expect(executeSessionTool).toHaveBeenCalledOnce();

    placementStore.isWorkerTurnToolAuthorized.mockReturnValue(true);
    executeSessionTool.mockImplementationOnce(async () => {
      placementStore.validateWorkerTurn.mockReturnValue(false);
      return result;
    });
    await expect(workerService.executeSessionTool(identity, "portal", request)).resolves.toEqual({
      ok: false,
      closeReason: "placement-mismatch",
    });
  });
});
