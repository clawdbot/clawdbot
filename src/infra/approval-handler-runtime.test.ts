import { describe, expect, it, vi } from "vitest";
import {
  createChannelApprovalHandlerFromCapability,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";
import {
  createApprovalNativeRuntimeAdapterStubs,
  type ApprovalNativeRuntimeAdapterStubParams,
} from "./approval-handler.test-helpers.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

type ApprovalCapability = NonNullable<
  Parameters<typeof createChannelApprovalHandlerFromCapability>[0]["capability"]
>;
type ApprovalNativeAdapter = NonNullable<ApprovalCapability["native"]>;

const TEST_HANDLER_PARAMS = {
  label: "test/approval-handler",
  clientDisplayName: "Test Approval Handler",
  channel: "test",
  channelLabel: "Test",
  cfg: { channels: {} } as never,
} as const;

function makeSequentialPendingDeliveryMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "1" })
    .mockResolvedValueOnce({ messageId: "2" });
}

function makeSequentialPendingBindingMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ bindingId: "bound-1" })
    .mockResolvedValueOnce({ bindingId: "bound-2" });
}

function makeExecApprovalRequest(id: string): ExecApprovalRequest {
  return {
    id,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "echo hi",
      turnSourceChannel: "test",
      turnSourceTo: "origin-chat",
    },
    createdAtMs: Date.now(),
  };
}

function makeNativeApprovalCapability(
  params: {
    preferredSurface?: ReturnType<
      ApprovalNativeAdapter["describeDeliveryCapabilities"]
    >["preferredSurface"];
    supportsApproverDmSurface?: boolean;
    resolveApproverDmTargets?: ApprovalNativeAdapter["resolveApproverDmTargets"];
  } & ApprovalNativeRuntimeAdapterStubParams = {},
): ApprovalCapability {
  const preferredSurface = params.preferredSurface ?? "origin";
  return {
    native: {
      describeDeliveryCapabilities: vi.fn().mockReturnValue({
        enabled: true,
        preferredSurface,
        supportsOriginSurface: true,
        supportsApproverDmSurface: params.supportsApproverDmSurface ?? false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: vi.fn().mockReturnValue({ to: "origin-chat" }),
      ...(params.resolveApproverDmTargets
        ? { resolveApproverDmTargets: params.resolveApproverDmTargets }
        : {}),
    },
    nativeRuntime: createApprovalNativeRuntimeAdapterStubs(params),
  };
}

function createTestApprovalHandler(capability: ApprovalCapability) {
  return createChannelApprovalHandlerFromCapability({
    capability,
    ...TEST_HANDLER_PARAMS,
  });
}

type ApprovalHandlerRuntime = NonNullable<Awaited<ReturnType<typeof createTestApprovalHandler>>>;

function expectApprovalRuntime(
  runtime: Awaited<ReturnType<typeof createTestApprovalHandler>>,
): ApprovalHandlerRuntime {
  if (runtime === null) {
    throw new Error("Expected approval handler runtime");
  }
  expect(typeof runtime.handleRequested).toBe("function");
  return runtime;
}

function firstCallArg(mock: ReturnType<typeof vi.fn>): unknown {
  return mock.mock.calls[0]?.[0];
}

describe("createChannelApprovalHandlerFromCapability", () => {
  it("returns null when the capability does not expose a native runtime", async () => {
    await expect(
      createChannelApprovalHandlerFromCapability({
        capability: {},
        ...TEST_HANDLER_PARAMS,
      }),
    ).resolves.toBeNull();
  });

  it("returns a runtime when the capability exposes a native runtime", async () => {
    const runtime = await createChannelApprovalHandlerFromCapability({
      capability: {
        nativeRuntime: {
          availability: {
            isConfigured: vi.fn().mockReturnValue(true),
            shouldHandle: vi.fn().mockReturnValue(true),
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
        },
      },
      ...TEST_HANDLER_PARAMS,
    });

    expectApprovalRuntime(runtime);
  });

  it("preserves the original request and resolved approval kind when stop-time cleanup unbinds", async () => {
    const unbindPending = vi.fn();
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        resolveApprovalKind: vi.fn().mockReturnValue("plugin"),
        unbindPending,
      }),
    );

    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = {
      id: "custom:1",
      expiresAtMs: Date.now() + 60_000,
      request: {
        turnSourceChannel: "test",
        turnSourceTo: "origin-chat",
      },
    } as never;

    await approvalRuntime.handleRequested(request);
    await approvalRuntime.stop();

    expect(unbindPending).toHaveBeenCalledOnce();
    const stopUnbind = firstCallArg(unbindPending) as
      | { request?: unknown; approvalKind?: string }
      | undefined;
    expect(stopUnbind?.request).toBe(request);
    expect(stopUnbind?.approvalKind).toBe("plugin");
  });

  it("ignores duplicate pending request ids before finalization", async () => {
    const unbindPending = vi.fn();
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        buildResolvedResult,
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = makeExecApprovalRequest("exec:1");

    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleResolved({
      id: "exec:1",
      decision: "approved",
      resolvedBy: "operator",
    } as never);

    expect(unbindPending).toHaveBeenCalledTimes(1);
    const unbind = firstCallArg(unbindPending) as
      | { entry?: unknown; binding?: unknown; request?: unknown }
      | undefined;
    expect(unbind?.entry).toEqual({ messageId: "1" });
    expect(unbind?.binding).toEqual({ bindingId: "bound-1" });
    expect(unbind?.request).toBe(request);
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
  });

  it("continues finalization cleanup after one resolved entry unbind failure", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        preferredSurface: "both",
        supportsApproverDmSurface: true,
        resolveApproverDmTargets: vi.fn().mockResolvedValue([{ to: "approver-dm" }]),
        buildResolvedResult,
        prepareTarget: vi.fn().mockImplementation(async ({ plannedTarget }) => ({
          dedupeKey: String(plannedTarget.target.to),
          target: { to: plannedTarget.target.to },
        })),
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:2");

    const approvalRuntime = expectApprovalRuntime(runtime);
    await approvalRuntime.handleRequested(request);
    await expect(
      approvalRuntime.handleResolved({
        id: "exec:2",
        decision: "approved",
        resolvedBy: "operator",
      } as never),
    ).resolves.toBeUndefined();

    expect(unbindPending).toHaveBeenCalledTimes(2);
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
    const resolvedPayload = firstCallArg(buildResolvedResult) as { entry?: unknown } | undefined;
    expect(resolvedPayload?.entry).toEqual({ messageId: "2" });
  });

  it("continues stop-time unbind cleanup when one binding throws", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:stop-1");

    const approvalRuntime = expectApprovalRuntime(runtime);
    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleRequested({
      ...request,
      id: "exec:stop-2",
    });

    await expect(approvalRuntime.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
    await expect(approvalRuntime.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
  });
});

describe("createLazyChannelApprovalNativeRuntimeAdapter", () => {
  it("loads the runtime lazily and reuses the loaded adapter", async () => {
    const explicitIsConfigured = vi.fn().mockReturnValue(true);
    const explicitShouldHandle = vi.fn().mockReturnValue(false);
    const buildPendingPayload = vi.fn().mockResolvedValue({ text: "pending" });
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload,
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec"],
      isConfigured: explicitIsConfigured,
      shouldHandle: explicitShouldHandle,
      load,
    });
    const cfg = { channels: {} } as never;
    const request = { id: "exec:1" } as never;
    const view = {} as never;

    expect(adapter.eventKinds).toEqual(["exec"]);
    expect(adapter.availability.isConfigured({ cfg })).toBe(true);
    expect(adapter.availability.shouldHandle({ cfg, request })).toBe(false);
    await expect(
      adapter.presentation.buildPendingPayload({
        cfg,
        request,
        approvalKind: "exec",
        nowMs: 1,
        view,
      }),
    ).resolves.toEqual({ text: "pending" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(explicitIsConfigured).toHaveBeenCalledWith({ cfg });
    expect(explicitShouldHandle).toHaveBeenCalledWith({ cfg, request });
    expect(buildPendingPayload).toHaveBeenCalledWith({
      cfg,
      request,
      approvalKind: "exec",
      nowMs: 1,
      view,
    });
  });

  it("keeps observe hooks synchronous and only uses the already-loaded runtime", async () => {
    const onDelivered = vi.fn();
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
      observe: {
        onDelivered,
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      isConfigured: vi.fn().mockReturnValue(true),
      shouldHandle: vi.fn().mockReturnValue(true),
      load,
    });

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(load).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();

    await adapter.presentation.buildPendingPayload({
      cfg: {} as never,
      request: { id: "exec:1" } as never,
      approvalKind: "exec",
      nowMs: 1,
      view: {} as never,
    });
    expect(load).toHaveBeenCalledTimes(1);

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(onDelivered).toHaveBeenCalledWith({ request: { id: "exec:1" } });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
