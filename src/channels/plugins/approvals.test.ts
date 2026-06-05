// Approval tests cover channel plugin approval request formatting and dispatch.
import { describe, expect, it, vi } from "vitest";
import { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";

function createNativeRuntimeStub() {
  return {
    availability: {
      isConfigured: vi.fn(),
      shouldHandle: vi.fn(),
    },
    presentation: {
      buildPendingPayload: vi.fn(),
      buildResolvedResult: vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: {
      prepareTarget: vi.fn(),
      deliverPending: vi.fn(),
    },
  };
}

describe("resolveChannelApprovalCapability", () => {
  it("returns undefined when approvalCapability is absent", () => {
    expect(resolveChannelApprovalCapability({})).toBeUndefined();
  });

  it("returns approvalCapability as the canonical approval contract", () => {
    const capabilityAuth = vi.fn();
    const capabilityAvailability = vi.fn();
    const capabilityNativeRuntime = createNativeRuntimeStub();
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
          getActionAvailabilityState: capabilityAvailability,
          delivery,
          nativeRuntime: capabilityNativeRuntime,
        },
      }),
    ).toEqual({
      authorizeActorAction: capabilityAuth,
      getActionAvailabilityState: capabilityAvailability,
      delivery,
      nativeRuntime: capabilityNativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("returns only delivery/runtime surfaces from approvalCapability", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          describeExecApprovalSetup,
          delivery,
          nativeRuntime,
          authorizeActorAction: vi.fn(),
        },
      }),
    ).toEqual({
      describeExecApprovalSetup,
      delivery,
      nativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});
