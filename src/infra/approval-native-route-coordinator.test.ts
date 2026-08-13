// Covers native approval route reporting behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter as createApprovalNativeRouteReporterRaw,
} from "./approval-native-route-coordinator.js";

const approvalRouteReporters: Array<ReturnType<typeof createApprovalNativeRouteReporterRaw>> = [];
const defaultRouteSelector = {
  shouldHandle: () => true,
  classifyRoute: () => "unbound" as const,
};

function createApprovalNativeRouteReporter(
  params: Omit<
    Parameters<typeof createApprovalNativeRouteReporterRaw>[0],
    "shouldHandle" | "classifyRoute"
  >,
) {
  const reporter = createApprovalNativeRouteReporterRaw({ ...params, ...defaultRouteSelector });
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
  it("keeps the local approval route visible when an unbound request has multiple runtimes", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const first = coordinator.createReporter({
      ...defaultRouteSelector,
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway: createGatewayRequestMock(),
    });
    const second = coordinator.createReporter({
      ...defaultRouteSelector,
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "ops",
      requestGateway: createGatewayRequestMock(),
    });
    first.start();
    second.start();

    expect(coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram" })).toBe(false);
    expect(
      coordinator.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "ops",
      }),
    ).toBe(true);
    coordinator.close();
  });

  it("selects the sole eligible runtime for an unbound request", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinator.createReporter({
        handledKinds: new Set(["exec"]),
        channel: "telegram",
        accountId,
        requestGateway,
        shouldHandle: () => eligible,
        classifyRoute: () => "unbound",
      });
    const defaultReporter = createReporter("default", true);
    const opsReporter = createReporter("ops", false);
    defaultReporter.start();
    opsReporter.start();
    const request = {
      id: "approval-filtered",
      request: { command: "echo hi", turnSourceChannel: "telegram" },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    expect(defaultReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    expect(opsReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ineligible",
    });
    coordinator.close();
  });

  it("keeps each channel's sole eligible runtime independent", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (channel: string) =>
      coordinator.createReporter({
        ...defaultRouteSelector,
        handledKinds: new Set(["exec"]),
        channel,
        accountId: "default",
        requestGateway,
      });
    const telegramReporter = createReporter("telegram");
    const matrixReporter = createReporter("matrix");
    telegramReporter.start();
    matrixReporter.start();
    const request = {
      id: "approval-two-channels",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    expect(telegramReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    expect(matrixReporter.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "selected",
    });
    coordinator.close();
  });

  it("fails an unbound multi-account route visibly and keeps the owner snapshot sticky", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string) =>
      coordinator.createReporter({
        ...defaultRouteSelector,
        handledKinds: new Set(["exec"]),
        channel: "telegram",
        accountId,
        requestGateway,
      });
    const first = createReporter("default");
    const second = createReporter("ops");
    first.start();
    second.start();
    const request = {
      id: "deadbeef-1234-4567-89ab-cdef01234567",
      request: {
        command: "echo hi",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat:123",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    expect(first.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ambiguous-owner",
    });
    expect(second.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ambiguous-owner",
    });
    await first.reportSkipped({ approvalKind: "exec", request, reason: "ambiguous-owner" });
    await second.reportSkipped({ approvalKind: "exec", request, reason: "ambiguous-owner" });

    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        channel: "telegram",
        to: "chat:123",
        message:
          "Approval required, but multiple channel accounts can handle this request. Open the Control UI or terminal UI to approve it.",
      }),
    );
    expect(requestGateway).not.toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: expect.stringContaining("/approve") }),
    );

    const late = createReporter("late");
    late.start();
    expect(late.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "ineligible" });
    coordinator.close();
  });

  it("selects every eligible explicit owner and no unrelated account", () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const createReporter = (accountId: string, eligible: boolean) =>
      coordinator.createReporter({
        handledKinds: new Set(["exec"]),
        channel: "telegram",
        accountId,
        requestGateway,
        shouldHandle: () => eligible,
        classifyRoute: () => "bound-or-explicit",
      });
    const first = createReporter("default", true);
    const second = createReporter("ops", true);
    const unrelated = createReporter("other", false);
    first.start();
    second.start();
    unrelated.start();
    const request = {
      id: "approval-explicit-owners",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    expect(first.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "selected" });
    expect(second.selectRequest({ approvalKind: "exec", request })).toEqual({ kind: "selected" });
    expect(unrelated.selectRequest({ approvalKind: "exec", request })).toEqual({
      kind: "ineligible",
    });
    coordinator.close();
  });

  it("isolates active routes and cleanup between Gateway instances", () => {
    const first = createApprovalNativeRouteCoordinator();
    const second = createApprovalNativeRouteCoordinator();
    const firstReporter = first.createReporter({
      ...defaultRouteSelector,
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway: createGatewayRequestMock(),
    });
    const secondReporter = second.createReporter({
      ...defaultRouteSelector,
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
      ...defaultRouteSelector,
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
    reporter.selectRequest({ approvalKind: "exec", request });
    await reporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

    const lateReporter = coordinator.createReporter({
      ...defaultRouteSelector,
      handledKinds: new Set(["exec"]),
      channel: "telegram",
      accountId: "default",
      requestGateway,
    });
    lateReporter.start();
    lateReporter.selectRequest({ approvalKind: "exec", request });
    await lateReporter.reportSkipped({ approvalKind: "exec", request, reason: "ineligible" });

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

      reporter.selectRequest({
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

      const cleanupCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5 * 60_000);
      expect(cleanupCall).toBeDefined();
      const [cleanupCallback] = cleanupCall ?? [];
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
    reporter.selectRequest({
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

    originReporter.selectRequest({
      approvalKind: "exec",
      request,
    });
    otherReporter.selectRequest({
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
    reporter.selectRequest({
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
