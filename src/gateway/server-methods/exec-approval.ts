// Exec approval gateway methods create, list, inspect, and resolve command
// approval requests, including iOS push delivery and requester visibility.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalGetParams,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveExecCommandHighlighting } from "../../config/exec-command-highlighting.js";
import { resolveCommandAnalysisSummaryForDisplay } from "../../infra/command-analysis/explain.js";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalDisplayTextWithStatus,
  sanitizeExecApprovalWarningText,
} from "../../infra/exec-approval-command-display.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  normalizeExecApprovalUnavailableDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "../../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resolveSystemRunApprovalRequestContext } from "../../infra/system-run-approval-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { InvalidApprovalIdError, type ExecApprovalManager } from "../exec-approval-manager.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";
import {
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  bindApprovalRequesterMetadata,
  bindApprovalReviewerDeviceIds,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
  respondPendingApprovalLookupError,
  resolvePendingApprovalRecord,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS = {
  reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
} as const;
const RESERVED_PLUGIN_APPROVAL_ID_PREFIX = "plugin:";

type ExecApprovalIosPushDelivery = {
  handleRequested?: (
    request: ExecApprovalRequest,
    opts?: {
      isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
    },
  ) => Promise<boolean>;
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
  handleExpired?: (request: ExecApprovalRequest) => Promise<void>;
};

function normalizeCommandSpans(
  spans: { startIndex: number; endIndex: number }[] | undefined,
  commandLength: number,
): { startIndex: number; endIndex: number }[] | undefined {
  if (!spans) {
    return undefined;
  }
  const candidates = spans
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= commandLength,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: { startIndex: number; endIndex: number }[] = [];
  let cursor = 0;
  for (const span of candidates) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push({ startIndex: span.startIndex, endIndex: span.endIndex });
    cursor = span.endIndex;
  }
  return accepted.length > 0 ? accepted : undefined;
}

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: ExecApprovalIosPushDelivery },
): GatewayRequestHandlers {
  return {
    "exec.approval.get": async ({ params, respond, client }) => {
      if (!validateExecApprovalGetParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.get params: ${formatValidationErrors(
              validateExecApprovalGetParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string };
      const resolved = resolvePendingApprovalRecord({
        manager,
        inputId: p.id,
        client,
        exposeAmbiguousPrefixError: true,
      });
      if (!resolved.ok) {
        respondPendingApprovalLookupError({ respond, response: resolved.response });
        return;
      }
      const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(
        resolved.snapshot.request,
      );
      respond(
        true,
        {
          id: resolved.approvalId,
          commandText,
          commandPreview,
          allowedDecisions: resolveExecApprovalRequestAllowedDecisions(resolved.snapshot.request),
          host: resolved.snapshot.request.host ?? null,
          nodeId: resolved.snapshot.request.nodeId ?? null,
          agentId: resolved.snapshot.request.agentId ?? null,
          expiresAtMs: resolved.snapshot.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
    },
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        commandArgv?: string[];
        env?: Record<string, string>;
        cwd?: string;
        systemRunPlan?: unknown;
        nodeId?: string;
        host?: string;
        security?: string;
        ask?: string;
        warningText?: string | null;
        unavailableDecisions?: string[];
        commandSpans?: {
          startIndex: number;
          endIndex: number;
        }[];
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        sessionId?: string;
        runId?: string;
        toolCallId?: string;
        turnSourceChannel?: string;
        turnSourceTo?: string;
        turnSourceAccountId?: string;
        turnSourceThreadId?: string | number;
        approvalReviewerDeviceIds?: string[];
        requireDeliveryRoute?: boolean;
        suppressDelivery?: boolean;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      // IDs are opaque cross-surface handles. Preserve every supplied byte so
      // the manager can reject unsafe values instead of silently normalizing them.
      const explicitId = p.id ?? null;
      const host = normalizeOptionalString(p.host) ?? "";
      const nodeId = normalizeOptionalString(p.nodeId) ?? "";
      const approvalContext = resolveSystemRunApprovalRequestContext({
        host,
        command: p.command,
        commandArgv: p.commandArgv,
        systemRunPlan: p.systemRunPlan,
        cwd: p.cwd,
        agentId: p.agentId,
        sessionKey: p.sessionKey,
      });
      const effectiveCommandArgv = approvalContext.commandArgv;
      const effectiveCwd = approvalContext.cwd;
      const effectiveAgentId = approvalContext.agentId;
      const effectiveSessionKey = approvalContext.sessionKey;
      const effectiveCommandText = approvalContext.commandText;
      const requestRunId = normalizeOptionalString(p.runId);
      if (host === "node" && !nodeId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "nodeId is required for host=node"),
        );
        return;
      }
      if (host === "node" && !approvalContext.plan) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "systemRunPlan is required for host=node"),
        );
        return;
      }
      if (effectiveCommandText.trim().length === 0) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
        return;
      }
      if (explicitId?.startsWith(RESERVED_PLUGIN_APPROVAL_ID_PREFIX)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `approval ids starting with ${RESERVED_PLUGIN_APPROVAL_ID_PREFIX} are reserved`,
          ),
        );
        return;
      }
      if (
        host === "node" &&
        (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "commandArgv is required for host=node"),
        );
        return;
      }
      const envBinding = buildSystemRunApprovalEnvBinding(p.env);
      const warningText = normalizeOptionalString(p.warningText);
      const runtimeConfig =
        typeof context.getRuntimeConfig === "function" ? context.getRuntimeConfig() : {};
      const commandHighlighting = resolveExecCommandHighlighting({
        config: runtimeConfig,
        agentId: effectiveAgentId,
      });
      const sanitizedCommandDisplay =
        sanitizeExecApprovalDisplayTextWithStatus(effectiveCommandText);
      if (sanitizedCommandDisplay.truncated || sanitizedCommandDisplay.oversized) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "command exceeds exec approval display limit", {
            details: {
              reason: "EXEC_APPROVAL_COMMAND_DISPLAY_LIMIT",
            },
          }),
        );
        return;
      }
      const sanitizedCommandText = sanitizedCommandDisplay.text;
      const commandAnalysis = await resolveCommandAnalysisSummaryForDisplay({
        host,
        commandText: effectiveCommandText,
        commandArgv: effectiveCommandArgv,
        cwd: effectiveCwd,
        sanitizeText: sanitizeExecApprovalWarningText,
      });
      const commandSpans =
        commandHighlighting && sanitizedCommandText === effectiveCommandText
          ? normalizeCommandSpans(p.commandSpans, sanitizedCommandText.length)
          : undefined;
      const systemRunBinding =
        host === "node"
          ? buildSystemRunApprovalBinding({
              argv: effectiveCommandArgv,
              cwd: effectiveCwd,
              agentId: effectiveAgentId,
              sessionKey: effectiveSessionKey,
              env: p.env,
            })
          : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const unavailableDecisions = normalizeExecApprovalUnavailableDecisions(
        p.unavailableDecisions,
      );
      const request = {
        command: sanitizedCommandText,
        commandPreview:
          host === "node" || !approvalContext.commandPreview
            ? undefined
            : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
        commandArgv: host === "node" ? undefined : effectiveCommandArgv,
        envKeys: envBinding.envKeys.length > 0 ? envBinding.envKeys : undefined,
        systemRunBinding: systemRunBinding?.binding ?? null,
        systemRunPlan: approvalContext.plan,
        cwd: effectiveCwd ?? null,
        nodeId: host === "node" ? nodeId : null,
        host: host || null,
        security: p.security ?? null,
        ask: p.ask ?? null,
        warningText: warningText ? sanitizeExecApprovalWarningText(warningText) : null,
        commandAnalysis,
        commandSpans,
        unavailableDecisions: unavailableDecisions.length > 0 ? unavailableDecisions : undefined,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions({
          ask: p.ask ?? null,
          unavailableDecisions,
        }),
        agentId: effectiveAgentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        sessionKey: effectiveSessionKey ?? null,
        sessionId: normalizeOptionalString(p.sessionId) ?? null,
        runId: requestRunId ?? null,
        toolCallId: normalizeOptionalString(p.toolCallId) ?? null,
        turnSourceChannel: normalizeOptionalString(p.turnSourceChannel) ?? null,
        turnSourceTo: normalizeOptionalString(p.turnSourceTo) ?? null,
        turnSourceAccountId: normalizeOptionalString(p.turnSourceAccountId) ?? null,
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };
      // This check is adjacent to manager creation with no await between them.
      // The abort owner records the tombstone before sweeping pending approvals.
      if (requestRunId && context.chatRunState.hasAbortMarker(requestRunId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval run already aborted", {
            details: { reason: "EXEC_APPROVAL_RUN_ABORTED" },
          }),
        );
        return;
      }
      let record: ReturnType<typeof manager.create>;
      try {
        record = manager.create(request, timeoutMs, explicitId);
      } catch (error) {
        if (error instanceof InvalidApprovalIdError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
              details: { code: error.code, reason: error.reason },
            }),
          );
          return;
        }
        throw error;
      }
      bindApprovalRequesterMetadata({ record, client });
      if (client?.internal?.approvalRuntime === true) {
        // Reviewer ids widen approval visibility, so only the server-trusted
        // approval runtime may bind them onto a pending exec approval.
        bindApprovalReviewerDeviceIds({
          record,
          deviceIds: p.approvalReviewerDeviceIds,
        });
      }
      // Use register() to synchronously add to pending map before sending any response.
      // This ensures the approval ID is valid immediately after the "accepted" response.
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
      const requestEvent: ExecApprovalRequest = buildRequestedApprovalEvent(record);
      const forwardRequest = opts?.forwarder?.handleRequested.bind(opts.forwarder);
      const iosPushRequest = opts?.iosPushDelivery?.handleRequested?.bind(opts.iosPushDelivery);
      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "exec.approval.requested",
        requestEvent,
        twoPhase,
        approvalKind: "exec",
        requireDeliveryRoute: p.requireDeliveryRoute,
        suppressDelivery: p.suppressDelivery,
        deliverRequest: () =>
          runApprovalRequestDeliveries({
            context,
            record,
            forward: forwardRequest
              ? [() => forwardRequest(requestEvent), "exec approvals: forward request failed"]
              : undefined,
            iosPush: iosPushRequest
              ? [
                  (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
                  "exec approvals: iOS push request failed",
                ]
              : undefined,
          }),
        afterDecision: async (decision) => {
          if (decision === null) {
            await opts?.iosPushDelivery?.handleExpired?.(requestEvent);
          }
        },
        afterDecisionErrorLabel: "exec approvals: iOS push expire failed",
      });
    },
    "exec.approval.waitDecision": async ({ params, respond, client, context }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        respond,
        resolveTerminalReason: (snapshot) => {
          const runId = normalizeOptionalString(snapshot.request.runId);
          return runId && context.chatRunState.hasAbortMarker(runId) ? "run-aborted" : undefined;
        },
      });
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validateExecApprovalResolveParams,
        methodName: "exec.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;
      let autoReviewResolution = false;
      await handleApprovalResolve({
        approvalKind: "exec",
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: true,
        validateDecision: (snapshot) => {
          const autoReviewIdentity =
            client?.internal?.approvalRuntime === true
              ? client.internal.agentRuntimeIdentity
              : undefined;
          if (autoReviewIdentity) {
            const requestAgentId = normalizeAgentId(snapshot.request.agentId ?? undefined);
            const requestSessionKey = normalizeOptionalString(snapshot.request.sessionKey);
            if (
              decision !== "allow-once" ||
              snapshot.request.host !== "node" ||
              requestAgentId !== autoReviewIdentity.agentId ||
              requestSessionKey !== autoReviewIdentity.sessionKey
            ) {
              return {
                message: "auto-review approval identity does not match request",
                details: { reason: "AUTO_REVIEW_APPROVAL_IDENTITY_MISMATCH" },
              };
            }
            autoReviewResolution = true;
          }
          const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(snapshot.request);
          return allowedDecisions.includes(decision)
            ? null
            : {
                message: "allow-always is unavailable for this command",
                details: APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS,
              };
        },
        resolveRecord: ({ approvalId, decision: decisionLocal, resolvedBy }) =>
          autoReviewResolution
            ? manager.resolveAutoReview(approvalId, resolvedBy)
            : manager.resolve(approvalId, decisionLocal, resolvedBy),
        resolvedEventName: "exec.approval.resolved",
        buildResolvedEvent: ({
          approvalId,
          decision: decisionLocal,
          resolvedBy,
          snapshot,
          nowMs,
        }) =>
          ({
            id: approvalId,
            decision: decisionLocal,
            resolvedBy,
            ts: nowMs,
            request: snapshot.request,
          }) satisfies ExecApprovalResolved,
        forwardResolved: (resolvedEvent) => opts?.forwarder?.handleResolved(resolvedEvent),
        forwardResolvedErrorLabel: "exec approvals: forward resolve failed",
        extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved
          ? [
              {
                run: (resolvedEvent) => opts.iosPushDelivery!.handleResolved!(resolvedEvent),
                errorLabel: "exec approvals: iOS push resolve failed",
              },
            ]
          : undefined,
      });
    },
  };
}
