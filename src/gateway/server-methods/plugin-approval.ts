// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalExternalPrepareParams,
  validatePluginApprovalExternalStartParams,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { sanitizeApprovalScope, type ApprovalScope } from "../../infra/approval-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  exceedsApprovalTextLimit,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../../infra/exec-approval-text-sanitize.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../../infra/plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import {
  normalizePluginExternalResolution,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  resolvePluginApprovalTimeoutMs,
  truncatePluginApprovalDetail,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { canReviewOperatorApproval } from "../operator-approval-authorization.js";
import type { PluginExternalVerificationRuntime } from "../plugin-external-verification-runtime.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
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

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: {
    forwarder?: ExecApprovalForwarder;
    iosPushDelivery?: PluginApprovalIosPushDelivery;
    externalVerificationRuntime?: PluginExternalVerificationRuntime;
  },
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond, client, context }) => {
      respond(
        true,
        listVisiblePendingApprovalRequests({
          manager,
          client,
          approvalKind: "plugin",
          ...(client?.authenticatedUserProfile ? { cfg: context.getRuntimeConfig() } : {}),
        }),
        undefined,
      );
    },
    "plugin.approval.external.prepare": async ({ params, respond, client }) => {
      if (!validatePluginApprovalExternalPrepareParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.external.prepare params: ${formatValidationErrors(
              validatePluginApprovalExternalPrepareParams.errors,
            )}`,
          ),
        );
        return;
      }
      if (!canReviewOperatorApproval(client)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            "external verification actions require an authorized approval reviewer",
          ),
        );
        return;
      }
      const p = params as {
        id: string;
        decision: "allow-once" | "allow-always";
      };
      try {
        const prepared = opts?.externalVerificationRuntime?.prepareNativeAction({
          approvalId: p.id,
          decision: p.decision,
          reviewerDeviceId: client?.connect.device?.id,
        });
        if (!prepared) {
          throw new Error("external verification approval runtime is not available");
        }
        respond(true, { intent: prepared.intent, actionToken: prepared.token }, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
        );
      }
    },
    "plugin.approval.external.start": async ({ params, respond, client }) => {
      if (!validatePluginApprovalExternalStartParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.external.start params: ${formatValidationErrors(
              validatePluginApprovalExternalStartParams.errors,
            )}`,
          ),
        );
        return;
      }
      if (!canReviewOperatorApproval(client)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            "external verification actions require an authorized approval reviewer",
          ),
        );
        return;
      }
      const p = params as {
        id: string;
        decision: "allow-once" | "allow-always";
        actionToken: string;
      };
      try {
        const dispatched = await opts?.externalVerificationRuntime?.dispatchNativeAction({
          approvalId: p.id,
          decision: p.decision,
          reviewerDeviceId: client?.connect.device?.id,
          token: p.actionToken,
        });
        if (!dispatched) {
          throw new Error("external verification approval runtime is not available");
        }
        const attemptOutcome = dispatched.attempt?.outcome;
        if (
          attemptOutcome === "failed" ||
          attemptOutcome === "cancelled" ||
          attemptOutcome === "timed-out"
        ) {
          throw new Error(`external verification attempt ${attemptOutcome}`);
        }
        respond(
          true,
          { outcome: dispatched.outcome, presentations: dispatched.presentations },
          undefined,
        );
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
        );
      }
    },
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      const internalRequest =
        client?.internal?.approvalRuntime === true &&
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params);
      // SAFETY: internalRequest already proved params is a non-array object.
      const rawParams = internalRequest ? (params as Record<string, unknown>) : null;
      const publicParams = rawParams
        ? Object.fromEntries(
            Object.entries(rawParams).filter(
              ([key]) => key !== "externalResolution" && key !== "runId" && key !== "sessionId",
            ),
          )
        : params;
      if (!validatePluginApprovalRequestParams(publicParams)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      // SAFETY: validatePluginApprovalRequestParams accepted publicParams above.
      const p = publicParams as {
        pluginId?: string | null;
        title: string;
        description: string;
        detail?: string | null;
        severity?: string | null;
        scope?: ApprovalScope | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        approvalReviewerDeviceIds?: string[] | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      let externalResolution: PluginApprovalRequestPayload["externalResolution"];
      try {
        externalResolution = internalRequest
          ? normalizePluginExternalResolution(
              // SAFETY: normalizePluginExternalResolution validates or throws on this shape.
              rawParams?.externalResolution as PluginApprovalRequestPayload["externalResolution"],
            )
          : null;
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid external verification: ${String(error)}`),
        );
        return;
      }
      const runId = internalRequest
        ? normalizeOptionalString(rawParams?.runId as string | undefined) // SAFETY: normalizeOptionalString rejects every non-string value.
        : null;
      const pluginId = normalizeOptionalString(p.pluginId ?? undefined);
      const toolName = normalizeOptionalString(p.toolName ?? undefined);
      const trustedAgentRuntime = client?.internal?.agentRuntimeIdentity;
      // Ownership for external verification is host-derived: the signed agent
      // runtime identity owner wins; an explicit payload pluginId only reaches
      // here from trusted in-process approval-runtime clients.
      const externalOwnerPluginId = trustedAgentRuntime?.approvalOwnerPluginId ?? pluginId;
      if (externalResolution && !runId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "external verification requires a host-derived run id",
          ),
        );
        return;
      }
      if (externalResolution && (!externalOwnerPluginId || !toolName)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "external verification requires host-derived plugin and tool ownership",
          ),
        );
        return;
      }
      if (
        externalResolution &&
        p.allowedDecisions?.some(
          (decision) => decision === "allow-once" || decision === "allow-always",
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "generic and external allow decisions cannot overlap",
          ),
        );
        return;
      }
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);

      if (
        trustedAgentRuntime &&
        context.validateAgentRuntimeApprovalAuthority?.(trustedAgentRuntime) !== true
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "agent runtime approval authority is no longer active",
          ),
        );
        return;
      }

      if (trustedAgentRuntime && !trustedAgentRuntime.approvalOwnerPluginId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "signed plugin approval owner is unavailable"),
        );
        return;
      }

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const rawSessionKey = normalizeOptionalString(
        trustedAgentRuntime?.sessionKey ?? p.sessionKey,
      );
      const sessionOwner = rawSessionKey
        ? resolveRequestedSessionAgentId(
            context.getRuntimeConfig(),
            rawSessionKey,
            normalizeOptionalString(trustedAgentRuntime?.agentId ?? p.agentId),
          )
        : undefined;
      if (sessionOwner && !sessionOwner.ok) {
        respond(false, undefined, sessionOwner.error);
        return;
      }
      const sessionKey =
        rawSessionKey && sessionOwner?.ok
          ? resolveStoredSessionKeyForAgentStore({
              cfg: context.getRuntimeConfig(),
              agentId: sessionOwner.agentId,
              sessionKey: rawSessionKey,
            })
          : null;

      // Sanitize once at the creation boundary, like exec command text: the
      // raw record otherwise reaches channel messages, iOS push, and the web
      // modal unescaped (bidi/invisible spoofing). Escaping expands invisible
      // chars to \u{...}, so re-check the protocol caps: a spoof-heavy title
      // must fail loud here, not as a misleading registration throw later.
      const sanitizedTitle = sanitizeExecApprovalDisplayText(p.title);
      const sanitizedDescription = sanitizeExecApprovalWarningText(p.description);
      if (
        exceedsApprovalTextLimit(sanitizedTitle, PLUGIN_APPROVAL_TITLE_MAX_LENGTH) ||
        exceedsApprovalTextLimit(sanitizedDescription, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "approval title or description exceeds the display limit after sanitization",
          ),
        );
        return;
      }
      const rawDetail = normalizeTrimmedString(p.detail);
      // Untrusted display metadata gets the same escape as title/description:
      // pluginId/toolName/agentId are interpolated into channel approval text.
      // Host-minted runtime identity values stay authoritative and unescaped.
      const sanitizeMeta = (value?: string | null): string | null =>
        normalizeTrimmedString(value) === null
          ? null
          : sanitizeExecApprovalDisplayText(normalizeTrimmedString(value)!);
      const request: PluginApprovalRequestPayload = {
        pluginId: trustedAgentRuntime?.approvalOwnerPluginId ?? sanitizeMeta(p.pluginId),
        title: sanitizedTitle,
        description: sanitizedDescription,
        scope: p.scope ? sanitizeApprovalScope(p.scope) : null,
        detail:
          rawDetail === null
            ? null
            : truncatePluginApprovalDetail(sanitizeExecApprovalWarningText(rawDetail)),
        // SAFETY: schema validation constrained severity to the closed union above.
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: sanitizeMeta(p.toolName),
        toolCallId: p.toolCallId ?? null,
        ...(externalResolution ? { externalResolution } : {}),
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
                externalResolution,
              }),
            }
          : {}),
        agentId:
          trustedAgentRuntime?.agentId ??
          (sessionOwner?.ok ? sessionOwner.agentId : sanitizeMeta(p.agentId)),
        sessionKey,
        sessionId: internalRequest
          ? normalizeOptionalString(rawParams?.sessionId as string | undefined) // SAFETY: normalizeOptionalString rejects every non-string value.
          : null,
        runId: trustedAgentRuntime?.operationalRunInstance.runId ?? runId,
        turnSourceChannel: trustedAgentRuntime
          ? normalizeTrimmedString(trustedAgentRuntime.turnSourceChannel)
          : normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: trustedAgentRuntime
          ? normalizeTrimmedString(trustedAgentRuntime.turnSourceTo)
          : normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: trustedAgentRuntime
          ? normalizeTrimmedString(trustedAgentRuntime.turnSourceAccountId)
          : normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: trustedAgentRuntime
          ? (trustedAgentRuntime.turnSourceThreadId ?? null)
          : (p.turnSourceThreadId ?? null),
      };

      // The abort owner records its tombstone before sweeping approvals. Keep
      // this check adjacent to creation so an already-aborted run cannot park.
      if (runId && context.chatRunState.hasAbortMarker(runId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval run already aborted", {
            details: { reason: "PLUGIN_APPROVAL_RUN_ABORTED" },
          }),
        );
        return;
      }

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      if (trustedAgentRuntime) {
        record.agentRuntimeDelegatedAuthority = trustedAgentRuntime.delegatedAuthority;
      }
      if (
        trustedAgentRuntime?.executionIdentity &&
        request.runId === trustedAgentRuntime.executionIdentity.runId
      ) {
        record.executionIdentityToken = trustedAgentRuntime.executionIdentity;
      }
      bindApprovalRequesterMetadata({ record, client });
      if (client?.internal?.approvalRuntime === true) {
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

      const requestEvent = buildRequestedApprovalEvent(record, "plugin");
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

    "plugin.approval.waitDecision": async ({ params, respond, client, context }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        ...(client?.authenticatedUserProfile ? { cfg: context.getRuntimeConfig() } : {}),
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
      const { inputId, decision, reviewer } = resolveParams;
      await handleApprovalResolve({
        approvalKind: "plugin",
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        reviewer,
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
