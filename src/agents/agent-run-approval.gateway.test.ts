import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  createGatewayAgentRunApprovalHost,
  gatewayAgentRunApprovalHost,
  resolveGatewayAgentRunApprovalHost,
} from "./agent-run-approval.gateway.js";
import { noAgentRunApprovalHost } from "./agent-run-approval.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const requestApproval = gatewayAgentRunApprovalHost.plugin!.request;

function mockAbortableGatewayCall() {
  const abortRequest = vi.fn(async () => ({}));
  mockCallGatewayTool.mockImplementationOnce(
    (_method, _options, _params, extra) =>
      new Promise((_resolve, reject) => {
        const abortOptions = extra as
          | {
              signal?: AbortSignal;
              onSignalAbort?: (request: typeof abortRequest) => unknown;
            }
          | undefined;
        const signal = abortOptions?.signal;
        const onAbort = () => {
          void Promise.resolve(abortOptions?.onSignalAbort?.(abortRequest))
            .catch(() => undefined)
            .finally(() => {
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("approval request aborted"),
              );
            });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
  return abortRequest;
}

function requestPayload() {
  return {
    pluginId: "test-plugin",
    title: "Approve operation",
    description: "Review the operation",
    toolName: "exec",
    toolCallId: "call-1",
  };
}

describe("gatewayAgentRunApprovalHost", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("returns an immediate decision without waiting", async () => {
    const onRegistered = vi.fn();
    const requestApprovalWithReviewer = createGatewayAgentRunApprovalHost({
      approvalReviewerDeviceIds: ["device-1"],
      runtimeInstanceId: "approval-runtime-1",
    }).plugin!.request;
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: "allow-once",
    });

    await expect(
      requestApprovalWithReviewer({
        request: requestPayload(),
        timeoutMs: 5_000,
        onRegistered,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "allow-once" });
    expect(onRegistered).toHaveBeenCalledWith({ id: "approval-1" });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      {
        ...requestPayload(),
        approvalReviewerDeviceIds: ["device-1"],
        runtimeRequestId: expect.any(String),
        timeoutMs: 5_000,
        twoPhase: true,
      },
      {
        expectFinal: false,
        signal: undefined,
        instanceId: "approval-runtime-1",
        onSignalAbort: expect.any(Function),
      },
    );
  });

  it("does not accept an immediate decision after registration aborts the run", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
      onRegistered: () => {
        controller.abort(abortReason);
      },
    });

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("waits for a decision bound to the registered request", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "deny" });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      { outcome: "resolved", decision: "deny" },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.waitDecision",
      { timeoutMs: 15_000 },
      { id: "approval-1" },
      {
        signal: undefined,
        instanceId: expect.any(String),
        onSignalAbort: expect.any(Function),
      },
    );
    expect(mockCallGatewayTool.mock.calls[0]?.[3]?.instanceId).toBe(
      mockCallGatewayTool.mock.calls[1]?.[3]?.instanceId,
    );
  });

  it("does not accept a waited decision after the run aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockImplementationOnce(async () => {
        controller.abort(abortReason);
        return { id: "approval-1", decision: "allow-once" };
      })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("fails closed on a stale decision id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", deliveryRoute: "turn-source" })
      .mockResolvedValueOnce({ id: "approval-2", decision: "allow-once" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval response did not match the registered request.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("classifies an expired registered approval as timed out", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", deliveryRoute: "turn-source" })
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: ErrorCodes.INVALID_REQUEST,
          message: "approval expired or not found",
        }),
      );

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      { outcome: "timed-out", deliveryRoute: "turn-source" },
    );
  });

  it("reports an unavailable approval route", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: null,
    });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval unavailable (no approval route)",
      },
    );
  });

  it("classifies an invalid immediate decision as unavailable", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "approval-1",
        decision: "unexpected",
      })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval returned an invalid decision.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("cancels a registered approval with an invalid waited decision", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "unexpected" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval returned an invalid decision.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("does not tombstone a definitive request rejection", async () => {
    const requestFailure = new GatewayClientRequestError({
      code: ErrorCodes.INVALID_REQUEST,
      message: "request failed",
    });
    mockCallGatewayTool.mockRejectedValueOnce(requestFailure);

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: expect.stringContaining("Plugin approval request rejected:"),
      },
    );
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("retries without runtime request identity for a pre-upgrade Gateway", async () => {
    mockCallGatewayTool
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: ErrorCodes.INVALID_REQUEST,
          message:
            "invalid plugin.approval.request params: at root: unexpected property 'runtimeRequestId'",
        }),
      )
      .mockResolvedValueOnce({
        id: "approval-legacy",
        decision: "allow-once",
      });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      { outcome: "resolved", decision: "allow-once" },
    );
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      runtimeRequestId: expect.any(String),
    });
    expect(mockCallGatewayTool.mock.calls[1]?.[2]).toEqual({
      ...requestPayload(),
      timeoutMs: 5_000,
      twoPhase: true,
    });
  });

  it("does not start a legacy retry after the run aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    let rejectModernRequest: ((reason?: unknown) => void) | undefined;
    mockCallGatewayTool.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectModernRequest = reject;
        }),
    );

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(rejectModernRequest).toBeTypeOf("function"));
    rejectModernRequest?.(
      new GatewayClientRequestError({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "invalid plugin.approval.request params: at root: unexpected property 'runtimeRequestId'",
      }),
    );
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("cancels an aborted legacy retry by its registered approval id", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    let resolveLegacyRequest: ((value: { id: string }) => void) | undefined;
    mockCallGatewayTool
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: ErrorCodes.INVALID_REQUEST,
          message:
            "invalid plugin.approval.request params: at root: unexpected property 'runtimeRequestId'",
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLegacyRequest = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledTimes(2));
    controller.abort(abortReason);
    resolveLegacyRequest?.({ id: "approval-legacy" });

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool.mock.calls[1]?.[3]).toEqual({
      expectFinal: false,
      signal: undefined,
      instanceId: expect.any(String),
      onSignalAbort: undefined,
    });
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-legacy" },
      { instanceId: expect.any(String) },
    );
  });

  it("cancels an ambiguous request failure by runtime request id", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("request transport failed"));

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval required (approval host unavailable)",
      },
    );
    const requestParams = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { runtimeRequestId?: unknown }
      | undefined;
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { runtimeRequestId: requestParams?.runtimeRequestId },
      { instanceId: expect.any(String) },
    );
  });

  it("cancels a registered approval after a wait transport failure", async () => {
    const waitFailure = new Error("wait failed");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockRejectedValueOnce(waitFailure);

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval required (approval host unavailable)",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("rethrows the run abort reason from the decision wait", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-1" });
    const abortRequest = mockAbortableGatewayCall();

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledTimes(2));
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(abortRequest).toHaveBeenCalledWith("plugin.approval.cancel", { id: "approval-1" });
  });

  it("cancels when the run aborts between registration and the decision wait", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
      onRegistered: () => {
        controller.abort(abortReason);
      },
    });

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("rethrows the run abort reason while registering", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const abortRequest = mockAbortableGatewayCall();

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      {
        ...requestPayload(),
        runtimeRequestId: expect.any(String),
        timeoutMs: 5_000,
        twoPhase: true,
      },
      {
        expectFinal: false,
        signal: controller.signal,
        instanceId: expect.any(String),
        onSignalAbort: expect.any(Function),
      },
    );
    const requestParams = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { runtimeRequestId?: unknown }
      | undefined;
    const runtimeRequestId = requestParams?.runtimeRequestId;
    expect(runtimeRequestId).toEqual(expect.any(String));
    expect(abortRequest).toHaveBeenCalledWith("plugin.approval.cancel", { runtimeRequestId });
  });

  it("does not register an approval for a pre-aborted run", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    controller.abort(abortReason);

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("cancels the registered approval when registration notification fails", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ cancelled: true });

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        onRegistered: () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });
});

describe("resolveGatewayAgentRunApprovalHost", () => {
  it("preserves explicit no-host state ahead of inherited and Gateway defaults", () => {
    const inheritedApprovalHost = createGatewayAgentRunApprovalHost();

    expect(
      resolveGatewayAgentRunApprovalHost({
        approvalHostMode: "none",
        inheritedApprovalHost,
        approvalReviewerDeviceId: "device-reviewer",
      }),
    ).toBe(noAgentRunApprovalHost);
    expect(
      resolveGatewayAgentRunApprovalHost({
        inheritedApprovalHost,
        approvalReviewerDeviceId: "device-reviewer",
      }),
    ).toBe(inheritedApprovalHost);
    expect(resolveGatewayAgentRunApprovalHost({})).toBe(gatewayAgentRunApprovalHost);
  });

  it("binds a Gateway-owned run to its initiating reviewer device", async () => {
    mockCallGatewayTool.mockReset().mockResolvedValueOnce({
      id: "approval-device-bound",
      decision: "deny",
    });
    const host = resolveGatewayAgentRunApprovalHost({
      approvalReviewerDeviceId: " device-reviewer ",
    });

    await expect(
      host.plugin!.request({
        request: requestPayload(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "deny" });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      expect.objectContaining({
        approvalReviewerDeviceIds: ["device-reviewer"],
      }),
      expect.objectContaining({
        expectFinal: false,
        instanceId: expect.any(String),
      }),
    );
  });
});
