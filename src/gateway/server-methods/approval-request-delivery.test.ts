import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";

const handleApprovalWebPushRequestedMock = vi.fn(() => false);

const approvalDeliveryCallers = [
  {
    name: "exec approvals",
    approvalKind: "exec",
    id: "approval-first-exec-delivery",
    request: { command: "echo ok" },
  },
  {
    name: "plugin approvals",
    approvalKind: "plugin",
    id: "plugin:approval-first-plugin-delivery",
    request: { pluginId: "example", title: "Sensitive action", description: "Approve action" },
  },
  {
    name: "plugin node policies",
    approvalKind: "plugin",
    id: "plugin:approval-first-node-policy-delivery",
    request: {
      pluginId: "example",
      title: "Sensitive node action",
      description: "Approve node action",
      severity: "warning",
    },
  },
] as const;

async function expectPromptDelivery(delivery: boolean | Promise<boolean>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedDelivery = Promise.race([
      Promise.resolve(delivery),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 100);
      }),
    ]);
    await expect(timedDelivery).resolves.toBe(true);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function deliveryContext(error?: (message: string) => void) {
  return {
    approvalWebPushDelivery: { handleRequested: handleApprovalWebPushRequestedMock },
    ...(error ? { logGateway: { error } } : {}),
  };
}

describe("runApprovalRequestDeliveries", () => {
  beforeEach(() => {
    handleApprovalWebPushRequestedMock.mockReset();
    handleApprovalWebPushRequestedMock.mockReturnValue(false);
  });

  it("returns false synchronously when no external routes exist", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-no-delivery");

    expect(runApprovalRequestDeliveries({ context: deliveryContext(), record })).toBe(false);
  });

  it("counts a successful approval Web Push as an external route", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-web-push");
    handleApprovalWebPushRequestedMock.mockResolvedValue(true);

    const delivery = runApprovalRequestDeliveries({ context: deliveryContext(), record });

    await expect(delivery).resolves.toBe(true);
    expect(handleApprovalWebPushRequestedMock).toHaveBeenCalledWith(record);
  });

  it.each(approvalDeliveryCallers)(
    "immediately reports a successful $name forward while iOS push remains pending",
    async ({ approvalKind, id, request }) => {
      const manager = new ExecApprovalManager<typeof request>({ approvalKind });
      const record = manager.create(request, 60_000, id);
      const started: string[] = [];

      const delivery = runApprovalRequestDeliveries({
        context: deliveryContext(),
        record,
        forward: [
          async () => {
            started.push("forward");
            return true;
          },
          "forward failed",
        ],
        iosPush: [
          async () => {
            started.push("push");
            return await new Promise<boolean>(() => {});
          },
          "push failed",
        ],
      });

      expect(started).toEqual(["forward", "push"]);
      await expectPromptDelivery(delivery);
    },
  );

  it.each(approvalDeliveryCallers)(
    "immediately reports a successful $name iOS push while forwarding remains pending",
    async ({ approvalKind, id, request }) => {
      const manager = new ExecApprovalManager<typeof request>({ approvalKind });
      const record = manager.create(request, 60_000, id);
      const started: string[] = [];

      const delivery = runApprovalRequestDeliveries({
        context: deliveryContext(),
        record,
        forward: [
          async () => {
            started.push("forward");
            return await new Promise<boolean>(() => {});
          },
          "forward failed",
        ],
        iosPush: [
          async () => {
            started.push("push");
            return true;
          },
          "push failed",
        ],
      });

      expect(started).toEqual(["forward", "push"]);
      await expectPromptDelivery(delivery);
    },
  );

  it.each([
    { name: "both routes decline", forwardRejects: false, pushRejects: false },
    { name: "forwarding rejects", forwardRejects: true, pushRejects: false },
    { name: "iOS push rejects", forwardRejects: false, pushRejects: true },
    { name: "both routes reject", forwardRejects: true, pushRejects: true },
  ])("reports false after $name", async ({ forwardRejects, pushRejects }) => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-all-deliveries-fail");
    const error = vi.fn();

    const delivery = runApprovalRequestDeliveries({
      context: deliveryContext(error),
      record,
      forward: [
        async () => {
          if (forwardRejects) {
            throw new Error("forward offline");
          }
          return false;
        },
        "forward failed",
      ],
      iosPush: [
        async () => {
          if (pushRejects) {
            throw new Error("push offline");
          }
          return false;
        },
        "push failed",
      ],
    });

    await expect(delivery).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(Number(forwardRejects) + Number(pushRejects));
    if (forwardRejects) {
      expect(error).toHaveBeenCalledWith("forward failed: Error: forward offline");
    }
    if (pushRejects) {
      expect(error).toHaveBeenCalledWith("push failed: Error: push offline");
    }
  });

  it("continues handling a late route rejection after another route succeeds", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-late-push-failure");
    const error = vi.fn();
    let rejectPush: ((reason: Error) => void) | undefined;
    const pendingPush = new Promise<boolean>((_resolve, reject) => {
      rejectPush = reject;
    });

    const delivery = runApprovalRequestDeliveries({
      context: deliveryContext(error),
      record,
      forward: [async () => true, "forward failed"],
      iosPush: [async () => await pendingPush, "push failed"],
    });

    await expectPromptDelivery(delivery);
    expect(error).not.toHaveBeenCalled();
    rejectPush?.(new Error("offline after delivery"));
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("push failed: Error: offline after delivery");
    });
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
        context: deliveryContext(error),
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
