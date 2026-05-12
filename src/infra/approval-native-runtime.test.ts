import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { clearApprovalNativeRouteStateForTest } from "./approval-native-route-coordinator.js";
import {
  createChannelNativeApprovalRuntime,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
  vi.useRealTimers();
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const arg = mock.mock.calls[index]?.[0];
  return requireRecord(arg);
}

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it("dedupes converged prepared targets", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-room" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const prepareTarget = vi
      .fn()
      .mockImplementation(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) =>
          plannedTarget.target.to === "approver-1"
            ? {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-1" },
              }
            : {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-2" },
              },
      );
    const deliverTarget = vi
      .fn()
      .mockImplementation(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => ({
          channelId: preparedTarget.channelId,
        }),
      );
    const onDuplicateSkipped = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
    });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "shared-dm" }]);
    expect(result.deliveryPlan.notifyOriginWhenDmOnly).toBe(true);
  });

  it("continues after per-target delivery failures", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: false,
        supportsApproverDmSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const onDeliveryError = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      },
      onDeliveryError,
    });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "secondary",
      eventKinds: ["exec", "plugin"] as const,
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget,
      deliverTarget,
      finalizeResolved,
    });

    await runtime.handleRequested({
      id: "plugin:req-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    });
    await runtime.handleResolved({
      id: "plugin:req-1",
      decision: "allow-once",
      ts: 1,
    });

    const pendingCall = mockCallArg(buildPendingContent);
    expect(requireRecord(pendingCall.request).id).toBe("plugin:req-1");
    expect(pendingCall.approvalKind).toBe("plugin");
    expect(typeof pendingCall.nowMs).toBe("number");

    const prepareCall = mockCallArg(prepareTarget);
    expect(prepareCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(requireRecord(prepareCall.request).id).toBe("plugin:req-1");
    expect(prepareCall.approvalKind).toBe("plugin");
    expect(prepareCall.pendingContent).toBe("pending plugin");

    const deliverCall = mockCallArg(deliverTarget);
    expect(deliverCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(deliverCall.preparedTarget).toEqual({ chatId: "plugin:secondary" });
    expect(requireRecord(deliverCall.request).id).toBe("plugin:req-1");
    expect(deliverCall.approvalKind).toBe("plugin");
    expect(deliverCall.pendingContent).toBe("pending plugin");

    const capabilitiesCall = mockCallArg(describeDeliveryCapabilities);
    expect(capabilitiesCall.cfg).toEqual({});
    expect(capabilitiesCall.accountId).toBe("secondary");
    expect(capabilitiesCall.approvalKind).toBe("plugin");
    expect(requireRecord(capabilitiesCall.request).id).toBe("plugin:req-1");

    const dmTargetsCall = mockCallArg(resolveApproverDmTargets);
    expect(dmTargetsCall.cfg).toEqual({});
    expect(dmTargetsCall.accountId).toBe("secondary");
    expect(dmTargetsCall.approvalKind).toBe("plugin");
    expect(requireRecord(dmTargetsCall.request).id).toBe("plugin:req-1");

    const resolvedCall = mockCallArg(finalizeResolved);
    expect(requireRecord(resolvedCall.request).id).toBe("plugin:req-1");
    expect(requireRecord(resolvedCall.resolved)).toEqual({
      id: "plugin:req-1",
      decision: "allow-once",
      ts: 1,
    });
    expect(resolvedCall.entries).toEqual([{ chatId: "plugin:secondary", messageId: "m1" }]);
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-expiry",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nowMs: Date.now,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "req-1",
      request: {
        command: "echo hi",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const expiredCall = mockCallArg(finalizeExpired);
    expect(requireRecord(expiredCall.request).id).toBe("req-1");
    expect(expiredCall.entries).toEqual([{ chatId: "owner", messageId: "m1" }]);
    vi.useRealTimers();
  });
});
