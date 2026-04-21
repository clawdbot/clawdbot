import { vi } from "vitest";
import type { ChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime.js";

export type ApprovalNativeRuntimeAdapterStubParams = {
  resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
  buildResolvedResult?: ChannelApprovalNativeRuntimeAdapter["presentation"]["buildResolvedResult"];
  unbindPending?: NonNullable<ChannelApprovalNativeRuntimeAdapter["interactions"]>["unbindPending"];
  prepareTarget?: ChannelApprovalNativeRuntimeAdapter["transport"]["prepareTarget"];
  deliverPending?: ChannelApprovalNativeRuntimeAdapter["transport"]["deliverPending"];
  bindPending?: NonNullable<ChannelApprovalNativeRuntimeAdapter["interactions"]>["bindPending"];
};

export function createApprovalNativeRuntimeAdapterStubs(
  params: ApprovalNativeRuntimeAdapterStubParams = {},
): ChannelApprovalNativeRuntimeAdapter {
  return {
    resolveApprovalKind: params.resolveApprovalKind,
    availability: {
      isConfigured: vi.fn().mockReturnValue(true),
      shouldHandle: vi.fn().mockReturnValue(true),
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
    },
  };
}
