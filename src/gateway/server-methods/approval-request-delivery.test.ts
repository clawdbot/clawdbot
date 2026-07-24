import { describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";

describe("runApprovalRequestDeliveries", () => {
  it("returns false synchronously when no external routes exist", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-no-delivery");

    expect(runApprovalRequestDeliveries({ context: {}, record })).toBe(false);
  });

  it.each([
    {
      failedRoute: "forward",
      expectedError: "forward failed: Error: offline",
    },
    {
      failedRoute: "push",
      expectedError: "push failed: Error: offline",
    },
  ] as const)(
    "starts every route before awaiting and isolates $failedRoute failures",
    async ({ failedRoute, expectedError }) => {
      const manager = new ExecApprovalManager();
      const record = manager.create({ command: "echo ok" }, 60_000, "approval-deliveries");
      const started: string[] = [];
      const error = vi.fn();
      let finishDelivery: ((delivered: boolean) => void) | undefined;
      const successfulResult = new Promise<boolean>((resolve) => {
        finishDelivery = resolve;
      });

      const delivery = runApprovalRequestDeliveries({
        context: { logGateway: { error } },
        record,
        forward: [
          async () => {
            started.push("forward");
            if (failedRoute === "forward") {
              throw new Error("offline");
            }
            return await successfulResult;
          },
          "forward failed",
        ],
        iosPush: [
          async () => {
            started.push("push");
            if (failedRoute === "push") {
              throw new Error("offline");
            }
            return await successfulResult;
          },
          "push failed",
        ],
      });

      expect(started).toEqual(["forward", "push"]);
      finishDelivery?.(true);
      await expect(delivery).resolves.toBe(true);
      expect(error).toHaveBeenCalledWith(expectedError);
    },
  );
});
