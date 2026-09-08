import { describe, expect, it, vi } from "vitest";
import type { WorkerComputerParams } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import * as support from "./service.test-support.js";

const request: WorkerComputerParams = {
  command: "screen.snapshot",
  paramsJson: JSON.stringify({ executionId: "00000000-0000-4000-8000-000000000001" }),
};
const result = { resultJson: JSON.stringify({ format: "png", base64: "a".repeat(96 * 1024) }) };

describe("worker computer RPC authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits only granted desktop calls and fences them after the terminal ACK", async () => {
    const executeComputer = vi
      .fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeComputer"]>>()
      .mockResolvedValue(result);
    const { identity, placementStore, workerService } = support.placementHarness(
      "computer-authority",
      "computer-session",
      { executeComputer, liveEvents: support.sequencedLiveEvents().liveEvents },
    );
    await expect(workerService.executeComputer(identity, request)).resolves.toEqual({
      ok: true,
      result,
    });
    expect(placementStore.isWorkerTurnToolAuthorized).toHaveBeenCalledWith(
      identity.turnClaim,
      "computer",
    );
    placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
    await expect(workerService.executeComputer(identity, request)).resolves.toEqual({
      ok: false,
      closeReason: "method-not-allowed",
    });
    placementStore.isWorkerTurnToolAuthorized.mockReturnValue(true);
    await workerService.pushLiveEvent(identity, support.terminalEvent(identity));
    await expect(workerService.executeComputer(identity, request)).resolves.toEqual({
      ok: false,
      closeReason: "placement-mismatch",
    });
    expect(executeComputer).toHaveBeenCalledOnce();
  });

  it.each(["placement", "grant"] as const)(
    "revalidates %s authority inside awaited dispatch and before its response",
    async (revoked) => {
      const executeComputer =
        vi.fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeComputer"]>>();
      const { identity, placementStore, workerService } = support.placementHarness(
        `computer-${revoked}`,
        `session-${revoked}`,
        { executeComputer },
      );
      executeComputer.mockImplementationOnce(async ({ assertCurrent }) => {
        assertCurrent();
        await Promise.resolve();
        if (revoked === "placement") {
          placementStore.validateWorkerTurn.mockReturnValue(false);
        } else {
          placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
        }
        expect(assertCurrent).toThrow("Worker computer authority closed");
        return result;
      });
      await expect(workerService.executeComputer(identity, request)).resolves.toEqual({
        ok: false,
        closeReason: revoked === "placement" ? "placement-mismatch" : "method-not-allowed",
      });
    },
  );

  it("rejects noncanonical parameters without invoking a desktop command", async () => {
    const executeComputer =
      vi.fn<NonNullable<support.WorkerEnvironmentServiceOptions["executeComputer"]>>();
    const { identity, workerService } = support.placementHarness(
      "computer-invalid",
      "session-invalid",
      { executeComputer },
    );
    await expect(
      workerService.executeComputer(identity, {
        ...request,
        paramsJson: '{"gatewayToken":"forbidden"}',
      }),
    ).resolves.toEqual({
      ok: false,
      closeReason: "invalid-frame",
    });
    expect(executeComputer).not.toHaveBeenCalled();
  });
});
