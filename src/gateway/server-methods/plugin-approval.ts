// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validatePluginApprovalCancelParams,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../../infra/plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  resolvePluginApprovalTimeoutMs,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { publishAppliedApprovalResolution } from "./approval-publication.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";
import {
  bindApprovalRequesterMetadata,
  bindApprovalReviewerDeviceIds,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type PluginApprovalIosPushDelivery = {
  handleRequested?: (
    request: PluginApprovalRequest,
    opts?: {
      isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
    },
  ) => Promise<boolean>;
  handleResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  handleExpired?: (request: PluginApprovalRequest) => Promise<void>;
};

const RUNTIME_REQUEST_CANCELLATION_TTL_MS = MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 30_000;
const MAX_RUNTIME_REQUEST_CANCELLATIONS_PER_RUNTIME = 1_024;
const MAX_RUNTIME_REQUEST_CANCELLATION_RUNTIMES = 1_024;
const MAX_SATURATED_RUNTIME_REQUEST_CANCELLATION_RUNTIMES = 1_024;

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: PluginApprovalIosPushDelivery },
): GatewayRequestHandlers {
  type CancellationRuntimeState = {
    requestIds: Map<string, number>;
    rejectUntilMs?: number;
  };
  const cancellationRuntimeStates = new Map<string, CancellationRuntimeState>();
  const saturatedCancellationRuntimeIds = new Map<string, number>();
  let rejectUnknownRuntimeUntilMs = 0;
  const pruneCancelledRuntimeRequests = (nowMs: number) => {
    if (rejectUnknownRuntimeUntilMs <= nowMs) {
      rejectUnknownRuntimeUntilMs = 0;
    }
    for (const [runtimeInstanceId, expiresAtMs] of saturatedCancellationRuntimeIds) {
      if (expiresAtMs <= nowMs) {
        saturatedCancellationRuntimeIds.delete(runtimeInstanceId);
      }
    }
    for (const [runtimeInstanceId, state] of cancellationRuntimeStates) {
      if ((state.rejectUntilMs ?? 0) <= nowMs) {
        delete state.rejectUntilMs;
      }
      for (const [runtimeRequestId, expiresAtMs] of state.requestIds) {
        if (expiresAtMs <= nowMs) {
          state.requestIds.delete(runtimeRequestId);
        }
      }
      if (state.requestIds.size === 0 && state.rejectUntilMs === undefined) {
        cancellationRuntimeStates.delete(runtimeInstanceId);
      }
    }
  };
  const rememberCancelledRuntimeRequest = (runtimeInstanceId: string, runtimeRequestId: string) => {
    const nowMs = Date.now();
    pruneCancelledRuntimeRequests(nowMs);
    const expiresAtMs = nowMs + RUNTIME_REQUEST_CANCELLATION_TTL_MS;
    let state = cancellationRuntimeStates.get(runtimeInstanceId);
    if (!state) {
      if (cancellationRuntimeStates.size >= MAX_RUNTIME_REQUEST_CANCELLATION_RUNTIMES) {
        const existingExpiry = saturatedCancellationRuntimeIds.get(runtimeInstanceId) ?? 0;
        if (
          existingExpiry > 0 ||
          saturatedCancellationRuntimeIds.size < MAX_SATURATED_RUNTIME_REQUEST_CANCELLATION_RUNTIMES
        ) {
          saturatedCancellationRuntimeIds.set(
            runtimeInstanceId,
            Math.max(existingExpiry, expiresAtMs),
          );
          return;
        }
        // Every bounded runtime slot is live. Preserve existing tombstones and
        // fail closed only for previously unseen runtimes until the fence expires.
        rejectUnknownRuntimeUntilMs = Math.max(rejectUnknownRuntimeUntilMs, expiresAtMs);
        return;
      }
      state = { requestIds: new Map() };
      cancellationRuntimeStates.set(runtimeInstanceId, state);
    }
    if ((state.rejectUntilMs ?? 0) > nowMs) {
      state.rejectUntilMs = Math.max(state.rejectUntilMs ?? 0, expiresAtMs);
      return;
    }
    if (
      !state.requestIds.has(runtimeRequestId) &&
      state.requestIds.size >= MAX_RUNTIME_REQUEST_CANCELLATIONS_PER_RUNTIME
    ) {
      // Losing an older tombstone can resurrect an approval whose run already
      // stopped. Saturation therefore rejects only this owner's runtime requests
      // until every potentially delayed registration is older than the maximum timeout.
      let rejectUntilMs = expiresAtMs;
      for (const cancelledUntilMs of state.requestIds.values()) {
        rejectUntilMs = Math.max(rejectUntilMs, cancelledUntilMs);
      }
      state.requestIds.clear();
      state.rejectUntilMs = rejectUntilMs;
      return;
    }
    state.requestIds.set(runtimeRequestId, expiresAtMs);
  };
  const isCancelledRuntimeRequest = (runtimeInstanceId: string, runtimeRequestId: string) => {
    const nowMs = Date.now();
    pruneCancelledRuntimeRequests(nowMs);
    const state = cancellationRuntimeStates.get(runtimeInstanceId);
    // Keep the tombstone until TTL expiry because the same stable request can
    // be delivered more than once after its owning run has already stopped.
    return (
      (saturatedCancellationRuntimeIds.get(runtimeInstanceId) ?? 0) > nowMs ||
      (rejectUnknownRuntimeUntilMs > nowMs &&
        state === undefined &&
        !saturatedCancellationRuntimeIds.has(runtimeInstanceId)) ||
      (state?.rejectUntilMs ?? 0) > nowMs ||
      state?.requestIds.has(runtimeRequestId) === true
    );
  };

  return {
    "plugin.approval.cancel": async ({ params, respond, client, context }) => {
      if (
        !assertValidParams(
          params,
          validatePluginApprovalCancelParams,
          "plugin.approval.cancel",
          respond,
        )
      ) {
        return;
      }
      if (client?.internal?.approvalRuntime !== true) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "plugin approval cancellation is internal-only"),
        );
        return;
      }

      const p = params as { id?: string; runtimeRequestId?: string };
      const runtimeInstanceId = normalizeOptionalString(client.connect?.client?.instanceId);
      const approvalById = p.id && runtimeInstanceId ? manager.getSnapshot(p.id) : undefined;
      const ownsApprovalById =
        runtimeInstanceId !== undefined &&
        approvalById != null &&
        approvalById.requestedByInstanceId === runtimeInstanceId;
      const approvalIds = p.id
        ? ownsApprovalById
          ? [p.id]
          : []
        : p.runtimeRequestId && runtimeInstanceId
          ? manager
              .listPendingRecords()
              .filter(
                (record) =>
                  record.requestedByInstanceId === runtimeInstanceId &&
                  record.requestedByRuntimeRequestId === p.runtimeRequestId,
              )
              .map((record) => record.id)
          : [];
      const cancelledRuntimeRequestId =
        p.runtimeRequestId ??
        (ownsApprovalById
          ? normalizeOptionalString(approvalById?.requestedByRuntimeRequestId)
          : undefined);
      if (cancelledRuntimeRequestId && runtimeInstanceId) {
        // Cancellation can overtake registration or a duplicate registration can
        // arrive later. Retain the logical request tombstone in both cases.
        rememberCancelledRuntimeRequest(runtimeInstanceId, cancelledRuntimeRequestId);
      }
      const resolvedBy = client.connect?.client?.displayName ?? client.connect?.client?.id ?? null;
      let cancelled = 0;
      for (const approvalId of approvalIds) {
        let result: ReturnType<typeof manager.forceDenyDetailed>;
        try {
          result = manager.forceDenyDetailed(
            approvalId,
            "run-aborted",
            { kind: "runtime", id: client.connect?.client?.id ?? null },
            "cancelled",
            undefined,
            false,
            resolvedBy,
          );
        } catch (error) {
          context.logGateway?.error?.(
            `plugin approvals: cancellation failed for ${approvalId}: ${String(error)}`,
          );
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "plugin approval storage unavailable"),
          );
          return;
        }
        if (result.outcome === "corrupt") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "plugin approval storage unavailable"),
          );
          return;
        }
        if (result.outcome !== "denied" || !result.liveRecord) {
          continue;
        }
        cancelled += 1;
        await publishAppliedApprovalResolution({
          record: result.record,
          liveRecord: result.liveRecord,
          context,
          forwarder: opts?.forwarder,
          pluginIosPushDelivery: opts?.iosPushDelivery,
        });
      }
      respond(true, { ok: true, cancelled }, undefined);
    },
    "plugin.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
    },
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      if (
        !assertValidParams(
          params,
          validatePluginApprovalRequestParams,
          "plugin.approval.request",
          respond,
        )
      ) {
        return;
      }
      const p = params as {
        pluginId?: string | null;
        title: string;
        description: string;
        detail?: string | null;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        approvalReviewerDeviceIds?: string[];
        runtimeRequestId?: string;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);
      const runtimeInstanceId =
        client?.internal?.approvalRuntime === true
          ? normalizeOptionalString(client.connect?.client?.instanceId)
          : undefined;
      const runtimeRequestId =
        client?.internal?.approvalRuntime === true
          ? normalizeOptionalString(p.runtimeRequestId)
          : undefined;
      if (
        runtimeInstanceId &&
        runtimeRequestId &&
        isCancelledRuntimeRequest(runtimeInstanceId, runtimeRequestId)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "plugin approval request cancelled"),
        );
        return;
      }

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const request: PluginApprovalRequestPayload = {
        pluginId: p.pluginId ?? null,
        title: p.title,
        description: p.description,
        detail: normalizeTrimmedString(p.detail),
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
              }),
            }
          : {}),
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client });
      if (client?.internal?.approvalRuntime === true) {
        record.requestedByRuntimeRequestId = runtimeRequestId;
        bindApprovalReviewerDeviceIds({
          record,
          deviceIds: p.approvalReviewerDeviceIds,
        });
      }

      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
        context,
      });
      if (!decisionPromise) {
        return;
      }

      const requestEvent = buildRequestedApprovalEvent(record);
      const forwardRequest = opts?.forwarder?.handlePluginApprovalRequested?.bind(opts.forwarder);
      const iosPushRequest = opts?.iosPushDelivery?.handleRequested?.bind(opts.iosPushDelivery);

      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase,
        approvalKind: "plugin",
        deliverRequest: () =>
          runApprovalRequestDeliveries({
            context,
            record,
            forward: forwardRequest
              ? [() => forwardRequest(requestEvent), "plugin approvals: forward request failed"]
              : undefined,
            iosPush: iosPushRequest
              ? [
                  (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
                  "plugin approvals: iOS push request failed",
                ]
              : undefined,
          }),
        afterDecision: async (decision) => {
          if (decision === null) {
            await opts?.iosPushDelivery?.handleExpired?.(requestEvent);
          }
        },
        afterDecisionErrorLabel: "plugin approvals: iOS push expire failed",
      });
    },

    "plugin.approval.waitDecision": async ({ params, respond, client }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        respond,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validatePluginApprovalResolveParams,
        methodName: "plugin.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;
      await handleApprovalResolve({
        approvalKind: "plugin",
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: false,
        validateDecision: (snapshot) =>
          resolveCanonicalPluginApprovalRequestAllowedDecisions(snapshot.request).includes(decision)
            ? null
            : {
                message: `${decision} is unavailable for this plugin approval`,
                details: {
                  allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
                    snapshot.request,
                  ),
                },
              },
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
        extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved
          ? [
              {
                run: (resolvedEvent) => opts.iosPushDelivery!.handleResolved!(resolvedEvent),
                errorLabel: "plugin approvals: iOS push resolve failed",
              },
            ]
          : undefined,
      });
    },
  };
}
