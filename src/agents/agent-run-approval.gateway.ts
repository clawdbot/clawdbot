import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { ErrorCodes } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { isApprovalNotFoundError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
import type {
  AgentRunApprovalHost,
  AgentRunPluginApprovalHost,
  AgentRunPluginApprovalResult,
} from "./agent-run-approval.js";
import { noAgentRunApprovalHost } from "./agent-run-approval.js";
import { callGatewayTool } from "./tools/gateway.js";

function resolveGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs, 10_000) ?? DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;
}

function readDecision(value: unknown): "allow-once" | "allow-always" | "deny" | null | undefined {
  return value === "allow-once" || value === "allow-always" || value === "deny"
    ? value
    : value === null
      ? null
      : undefined;
}

function isGatewayInvalidRequestError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError && error.gatewayCode === ErrorCodes.INVALID_REQUEST
  );
}

function isLegacyGatewayRuntimeRequestIdRejection(error: unknown): boolean {
  return (
    isGatewayInvalidRequestError(error) &&
    formatErrorMessage(error).includes("unexpected property 'runtimeRequestId'")
  );
}

function unavailableGatewayApprovalResult(
  phase: "request" | "wait",
  error: unknown,
  deliveryRoute?: string,
): AgentRunPluginApprovalResult {
  if (phase === "wait" && isApprovalNotFoundError(error)) {
    return {
      outcome: "timed-out",
      ...(deliveryRoute === "turn-source" ? { deliveryRoute } : {}),
    };
  }
  if (isGatewayInvalidRequestError(error)) {
    return {
      outcome: "unavailable",
      reason:
        phase === "request"
          ? `Plugin approval request rejected: ${formatErrorMessage(error)}`
          : `Plugin approval no longer available: ${formatErrorMessage(error)}`,
    };
  }
  return {
    outcome: "unavailable",
    reason: "Plugin approval required (approval host unavailable)",
  };
}

function throwIfApprovalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("approval request aborted");
  }
}

function rethrowApprovalAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("approval request aborted");
  }
}

async function cancelGatewayApproval(
  cancellation: { id: string } | { runtimeRequestId: string },
  runtimeInstanceId: string,
): Promise<void> {
  try {
    await callGatewayTool("plugin.approval.cancel", { timeoutMs: 10_000 }, cancellation, {
      instanceId: runtimeInstanceId,
    });
  } catch {
    // Cleanup is best-effort when the Gateway transport itself is unavailable.
  }
}

async function throwIfRegisteredApprovalAborted(params: {
  id: string;
  runtimeInstanceId: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.signal?.aborted) {
    return;
  }
  await cancelGatewayApproval({ id: params.id }, params.runtimeInstanceId);
  throw params.signal.reason ?? new Error("approval request aborted");
}

async function waitForGatewayDecision(params: {
  id: string;
  timeoutMs: number;
  runtimeInstanceId: string;
  signal?: AbortSignal;
}): Promise<{ id?: string; decision?: unknown } | null | undefined> {
  if (params.signal?.aborted) {
    await cancelGatewayApproval({ id: params.id }, params.runtimeInstanceId);
    throw params.signal.reason ?? new Error("approval request aborted");
  }
  return callGatewayTool<{ id?: string; decision?: unknown } | null | undefined>(
    "plugin.approval.waitDecision",
    { timeoutMs: resolveGatewayTimeoutMs(params.timeoutMs) },
    { id: params.id },
    {
      signal: params.signal,
      instanceId: params.runtimeInstanceId,
      onSignalAbort: (request) => request("plugin.approval.cancel", { id: params.id }),
    },
  );
}

async function requestGatewayPluginApproval(
  params: Parameters<AgentRunPluginApprovalHost["request"]>[0],
  approvalReviewerDeviceIds: readonly string[],
  runtimeInstanceId: string,
): Promise<AgentRunPluginApprovalResult> {
  const runtimeRequestId = randomUUID();
  let requestResult: {
    id?: string;
    decision?: unknown;
    deliveryRoute?: string;
  };
  throwIfApprovalAborted(params.signal);
  try {
    const requestPayload = {
      ...params.request,
      ...(approvalReviewerDeviceIds.length ? { approvalReviewerDeviceIds } : {}),
      timeoutMs: params.timeoutMs,
      twoPhase: true,
    };
    const requestOptions = {
      expectFinal: false,
      signal: params.signal,
      instanceId: runtimeInstanceId,
      onSignalAbort: (request: Parameters<NonNullable<CallGatewayOptions["onSignalAbort"]>>[0]) =>
        request("plugin.approval.cancel", {
          runtimeRequestId,
        }),
    };
    try {
      requestResult = await callGatewayTool<{
        id?: string;
        decision?: unknown;
        deliveryRoute?: string;
      }>(
        "plugin.approval.request",
        { timeoutMs: resolveGatewayTimeoutMs(params.timeoutMs) },
        {
          ...requestPayload,
          runtimeRequestId,
        },
        requestOptions,
      );
    } catch (error) {
      if (!isLegacyGatewayRuntimeRequestIdRejection(error)) {
        throw error;
      }
      throwIfApprovalAborted(params.signal);
      // Rolling upgrades can leave the CLI newer than its long-running Gateway.
      // The legacy Gateway can only cancel by its server-generated approval id,
      // so retain the registration response before honoring a concurrent abort.
      requestResult = await callGatewayTool<{
        id?: string;
        decision?: unknown;
        deliveryRoute?: string;
      }>(
        "plugin.approval.request",
        { timeoutMs: resolveGatewayTimeoutMs(params.timeoutMs) },
        requestPayload,
        { ...requestOptions, signal: undefined, onSignalAbort: undefined },
      );
    }
  } catch (error) {
    rethrowApprovalAbort(params.signal);
    if (!isGatewayInvalidRequestError(error)) {
      await cancelGatewayApproval({ runtimeRequestId }, runtimeInstanceId);
    }
    return unavailableGatewayApprovalResult("request", error);
  }

  const id = requestResult?.id;
  if (!id) {
    await cancelGatewayApproval({ runtimeRequestId }, runtimeInstanceId);
    return {
      outcome: "unavailable",
      reason: params.request.description || "Plugin approval request failed",
    };
  }
  try {
    params.onRegistered?.({ id });
  } catch (error) {
    await cancelGatewayApproval({ id }, runtimeInstanceId);
    throw error;
  }
  await throwIfRegisteredApprovalAborted({
    id,
    runtimeInstanceId,
    signal: params.signal,
  });
  if (Object.hasOwn(requestResult, "decision")) {
    const decision = readDecision(requestResult.decision);
    if (decision === null) {
      return {
        outcome: "unavailable",
        reason: "Plugin approval unavailable (no approval route)",
      };
    }
    if (decision === undefined) {
      await cancelGatewayApproval({ id }, runtimeInstanceId);
      return {
        outcome: "unavailable",
        reason: "Plugin approval returned an invalid decision.",
      };
    }
    return { outcome: "resolved", decision };
  }

  let waitResult: { id?: string; decision?: unknown } | null | undefined;
  try {
    waitResult = await waitForGatewayDecision({
      id,
      timeoutMs: params.timeoutMs,
      runtimeInstanceId,
      signal: params.signal,
    });
  } catch (error) {
    rethrowApprovalAbort(params.signal);
    if (!isApprovalNotFoundError(error)) {
      await cancelGatewayApproval({ id }, runtimeInstanceId);
    }
    return unavailableGatewayApprovalResult("wait", error, requestResult.deliveryRoute);
  }
  await throwIfRegisteredApprovalAborted({
    id,
    runtimeInstanceId,
    signal: params.signal,
  });
  if (waitResult && waitResult.id !== id) {
    await cancelGatewayApproval({ id }, runtimeInstanceId);
    return {
      outcome: "unavailable",
      reason: "Plugin approval response did not match the registered request.",
    };
  }
  const decision = readDecision(waitResult?.decision);
  if (decision) {
    return { outcome: "resolved", decision };
  }
  if (decision === undefined && waitResult) {
    await cancelGatewayApproval({ id }, runtimeInstanceId);
    return {
      outcome: "unavailable",
      reason: "Plugin approval returned an invalid decision.",
    };
  }
  return {
    outcome: "timed-out",
    ...(requestResult.deliveryRoute === "turn-source"
      ? { deliveryRoute: "turn-source" as const }
      : {}),
  };
}

export function createGatewayAgentRunApprovalHost(options?: {
  approvalReviewerDeviceIds?: readonly string[];
  runtimeInstanceId?: string;
}): AgentRunApprovalHost {
  const approvalReviewerDeviceIds = Object.freeze([
    ...new Set(options?.approvalReviewerDeviceIds?.map((value) => value.trim()).filter(Boolean)),
  ]);
  const runtimeInstanceId = options?.runtimeInstanceId?.trim() || randomUUID();
  return Object.freeze({
    plugin: Object.freeze<AgentRunPluginApprovalHost>({
      request: (params) =>
        requestGatewayPluginApproval(params, approvalReviewerDeviceIds, runtimeInstanceId),
    }),
  });
}

export const gatewayAgentRunApprovalHost = createGatewayAgentRunApprovalHost();

/** Resolves the exact approval owner selected by one Gateway agent request. */
export function resolveGatewayAgentRunApprovalHost(params: {
  approvalHostMode?: "none";
  inheritedApprovalHost?: AgentRunApprovalHost;
  approvalReviewerDeviceId?: string;
}): AgentRunApprovalHost {
  if (params.approvalHostMode === "none") {
    return noAgentRunApprovalHost;
  }
  if (params.inheritedApprovalHost) {
    return params.inheritedApprovalHost;
  }
  const approvalReviewerDeviceId = params.approvalReviewerDeviceId?.trim();
  return approvalReviewerDeviceId
    ? createGatewayAgentRunApprovalHost({
        approvalReviewerDeviceIds: [approvalReviewerDeviceId],
      })
    : gatewayAgentRunApprovalHost;
}
