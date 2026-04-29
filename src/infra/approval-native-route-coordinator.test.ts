import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApprovalNativeRouteStateForTest,
  createApprovalNativeRouteReporter,
} from "./approval-native-route-coordinator.js";

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
});

function createGatewayRequestMock() {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })) as unknown as (<T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>) &
    ReturnType<typeof vi.fn>;
}

describe("createApprovalNativeRouteReporter", () => {
  it("caps route-notice cleanup timers to five minutes", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const requestGateway = createGatewayRequestMock();
      const reporter = createApprovalNativeRouteReporter({
        handledKinds: new Set(["exec"]),
        channel: "slack",
        channelLabel: "Slack",
        accountId: "default",
        requestGateway,
      });
      reporter.start();

      reporter.observeRequest({
        approvalKind: "exec",
        request: {
          id: "approval-long",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
          },
          createdAtMs: 0,
          expiresAtMs: Date.now() + 24 * 60 * 60_000,
        },
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on runtimes that start after a request was already observed", async () => {
    const requestGateway = createGatewayRequestMock();
    const lateRuntimeGateway = createGatewayRequestMock();
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
      requestGateway,
    });
    reporter.start();
    reporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    const lateReporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
      requestGateway: lateRuntimeGateway,
    });
    lateReporter.start();

    await reporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
          threadId: "1712345678.123456",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [
        {
          surface: "approver-dm",
          target: {
            to: "user:owner",
          },
          reason: "preferred",
        },
      ],
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:approval-1",
    });
    expect(lateRuntimeGateway).not.toHaveBeenCalled();
  });

  it("does not suppress the notice when another account delivered to the same target id", async () => {
    const originGateway = createGatewayRequestMock();
    const otherGateway = createGatewayRequestMock();
    const request = {
      id: "approval-2",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    const originReporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work-a",
      requestGateway: originGateway,
    });
    const otherReporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work-b",
      requestGateway: otherGateway,
    });
    originReporter.start();
    otherReporter.start();

    originReporter.observeRequest({
      approvalKind: "exec",
      request,
    });
    otherReporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    await originReporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [
        {
          surface: "approver-dm",
          target: {
            to: "user:owner-a",
          },
          reason: "preferred",
        },
      ],
    });
    await otherReporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [
        {
          surface: "origin",
          target: {
            to: "channel:C123",
          },
          reason: "fallback",
        },
      ],
    });

    expect(originGateway).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "work-a",
      threadId: undefined,
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:approval-2",
    });
    expect(otherGateway).not.toHaveBeenCalled();
  });

  it("sends a manual fallback notice when native delivery reaches no targets", async () => {
    const requestGateway = createGatewayRequestMock();
    const request = {
      id: "deadbeef-1234-4567-89ab-cdef01234567",
      request: {
        command: "echo hi",
        allowedDecisions: ["allow-once", "deny"],
        turnSourceChannel: "discord",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "discord",
      channelLabel: "Discord",
      accountId: "default",
      requestGateway,
    });
    reporter.start();
    reporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    await reporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [
          {
            surface: "approver-dm",
            target: {
              to: "user:owner",
            },
            reason: "preferred",
          },
        ],
        originTarget: {
          to: "channel:C123",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [],
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      channel: "discord",
      to: "channel:C123",
      accountId: "default",
      threadId: undefined,
      message:
        "Approval required. I could not deliver the native approval request.\n" +
        "Reply with: /approve deadbeef allow-once|deny\n" +
        "If the short code is ambiguous, use the full id in /approve.",
      idempotencyKey: "approval-route-notice:deadbeef-1234-4567-89ab-cdef01234567",
    });
  });
});
