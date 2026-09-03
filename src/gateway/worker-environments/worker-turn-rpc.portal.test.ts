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

    await expect(
      workerService.executeSessionTool(identity, "portal", {
        toolCallId: "wrong-family",
        arguments: { action: "read", artifact_path: "scripts/helper.sh" },
      }),
    ).resolves.toEqual({ ok: false, closeReason: "invalid-frame" });
    expect(executeSessionTool).not.toHaveBeenCalled();

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

  it("returns actionable portal failures to an authorized worker", async () => {
    const executeSessionTool = vi
      .fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeSessionTool"]>>()
      .mockRejectedValue(new Error("portal port required"));
    const { identity, workerService } = support.placementHarness(
      "worker-portal-error",
      "session-portal-error",
      { executeSessionTool },
    );

    const result = await workerService.executeSessionTool(identity, "portal", {
      toolCallId: "portal-missing-port",
      action: "open",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected a worker tool result");
    }
    expect(JSON.parse(result.result.resultJson)).toEqual({
      content: [{ type: "text", text: expect.stringContaining("portal port required") }],
      details: { status: "error", error: "portal port required" },
    });
  });

  it.each(["placement", "tool"] as const)(
    "fences a failed portal operation after its %s authority is revoked",
    async (authority) => {
      const executeSessionTool =
        vi.fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeSessionTool"]>>();
      const { identity, placementStore, workerService } = support.placementHarness(
        `worker-portal-revoked-${authority}`,
        `session-portal-revoked-${authority}`,
        { executeSessionTool },
      );
      executeSessionTool.mockImplementationOnce(async () => {
        if (authority === "placement") {
          placementStore.validateWorkerTurn.mockReturnValue(false);
        } else {
          placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
        }
        throw new Error("Portal operation failed after authority changed");
      });

      await expect(
        workerService.executeSessionTool(identity, "portal", {
          toolCallId: "revoked-portal-call",
          action: "open",
          port: 3000,
        }),
      ).resolves.toEqual({
        ok: false,
        closeReason: authority === "placement" ? "placement-mismatch" : "method-not-allowed",
      });
    },
  );
});
