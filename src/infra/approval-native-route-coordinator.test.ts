// Covers native approval route reporting behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter as createApprovalNativeRouteReporterRaw,
} from "./approval-native-route-coordinator.js";

const approvalRouteReporters: Array<ReturnType<typeof createApprovalNativeRouteReporterRaw>> = [];

function createApprovalNativeRouteReporter(
  params: Parameters<typeof createApprovalNativeRouteReporterRaw>[0],
) {
  const reporter = createApprovalNativeRouteReporterRaw(params);
  approvalRouteReporters.push(reporter);
  return reporter;
}

afterEach(async () => {
  await Promise.all(approvalRouteReporters.splice(0).map((reporter) => reporter.stop()));
  vi.useRealTimers();
});

function createGatewayRequestMock() {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })) as unknown as (<T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>) &
    ReturnType<typeof vi.fn>;
}

describe("createApprovalNativeRouteReporter", () => {
  it("isolates active routes and cleanup between Gateway instances", () => {
    const first = createApprovalNativeRouteCoordinator();
    const second = createApprovalNativeRouteCoordinator();
    const firstReporter = first.createReporter({
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway: createGatewayRequestMock(),
    });
    const secondReporter = second.createReporter({
      handledKinds: new Set(["exec"]),
      channel: "discord",
      accountId: "default",
      requestGateway: createGatewayRequestMock(),
    });
    firstReporter.start();
    secondReporter.start();

    expect(
      first.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      second.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(false);

    first.close();
    expect(first.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(second.hasActiveRuntime({ approvalKind: "exec", channel: "discord" })).toBe(true);
    second.close();
  });

  it("cannot revive routes or notices after the owning Gateway closes", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const reporter = coordinator.createReporter({
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway,
    });
    const request = {
      id: "approval-after-close",
      request: {
        command: "echo hi",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat:123",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    reporter.start();
    coordinator.close();
    reporter.start();
    reporter.observeRequest({ approvalKind: "exec", request });
    await reporter.reportSkipped({ approvalKind: "exec", request });

    const lateReporter = coordinator.createReporter({
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway,
    });
    lateReporter.start();
    lateReporter.observeRequest({ approvalKind: "exec", request });
    await lateReporter.reportSkipped({ approvalKind: "exec", request });

    expect(coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

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

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const cleanupCall = setTimeoutSpy.mock.calls[0];
      if (cleanupCall === undefined) {
        throw new Error("expected cleanup timeout call");
      }
      const [cleanupCallback, cleanupDelayMs] = cleanupCall;
      expect(cleanupDelayMs).toBe(5 * 60_000);
      expect(cleanupCallback).toBeTypeOf("function");
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
