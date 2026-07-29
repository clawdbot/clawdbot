// Provides native approval runtime stubs for approval tests.
import { vi } from "vitest";
import type { ChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime.js";

// Shared approval-runtime stubs keep channel approval tests focused on route
// behavior instead of rebuilding the native adapter shape.
export type ApprovalNativeRuntimeAdapterStubParams = {
  resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
  shouldHandle?: ChannelApprovalNativeRuntimeAdapter["availability"]["shouldHandle"];
  buildResolvedResult?: ChannelApprovalNativeRuntimeAdapter["presentation"]["buildResolvedResult"];
  unbindPending?: NonNullable<ChannelApprovalNativeRuntimeAdapter["interactions"]>["unbindPending"];
  cancelDelivered?: NonNullable<
    ChannelApprovalNativeRuntimeAdapter["interactions"]
  >["cancelDelivered"];
  prepareTarget?: ChannelApprovalNativeRuntimeAdapter["transport"]["prepareTarget"];
  deliverPending?: ChannelApprovalNativeRuntimeAdapter["transport"]["deliverPending"];
  bindPending?: NonNullable<ChannelApprovalNativeRuntimeAdapter["interactions"]>["bindPending"];
};

/** Build a complete native approval adapter stub with per-test overrides. */
export function createApprovalNativeRuntimeAdapterStubs(
  params: ApprovalNativeRuntimeAdapterStubParams = {},
): ChannelApprovalNativeRuntimeAdapter {
  return {
    ...(params.resolveApprovalKind ? { resolveApprovalKind: params.resolveApprovalKind } : {}),
    availability: {
      isConfigured: vi.fn().mockReturnValue(true),
      shouldHandle: params.shouldHandle ?? vi.fn().mockReturnValue(true),
    },
    presentation: {
      buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
      buildResolvedResult: params.buildResolvedResult ?? vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: {
      prepareTarget:
        params.prepareTarget ??
        vi.fn().mockResolvedValue({
          dedupeKey: "origin-chat",
          target: { to: "origin-chat" },
        }),
      deliverPending: params.deliverPending ?? vi.fn().mockResolvedValue({ messageId: "1" }),
    },
    interactions: {
      bindPending: params.bindPending ?? vi.fn().mockResolvedValue({ bindingId: "bound" }),
      unbindPending: params.unbindPending,
      cancelDelivered: params.cancelDelivered,
    },
  };
}
