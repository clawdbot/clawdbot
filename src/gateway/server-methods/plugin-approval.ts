// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { sanitizeApprovalScope, type ApprovalScope } from "../../infra/approval-scope.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
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
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  resolvePluginApprovalTimeoutMs,
  truncatePluginApprovalDetail,
  truncatePluginApprovalDisplayField,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
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

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: PluginApprovalIosPushDelivery },
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
        scope?: ApprovalScope;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        approvalReviewerDeviceIds?: string[];
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);
      const trustedAgentRuntime = client?.internal?.agentRuntimeIdentity;

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
      // modal unescaped (bidi/invisible spoofing). Redaction and invisible-char
      // escaping are renderer-neutral; channel markup escaping belongs to the
      // renderer that owns the markup dialect, so the stored copy stays literal
      // for the Control UI, Teams, and Discord.
      const sanitizedTitle = truncatePluginApprovalDisplayField(
        sanitizeExecApprovalDisplayText(p.title),
        PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
      );
      const sanitizedDescription = truncatePluginApprovalDisplayField(
        sanitizeExecApprovalWarningText(p.description),
        PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
      );
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
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: sanitizeMeta(p.toolName),
        toolCallId: p.toolCallId ?? null,
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
              }),
            }
          : {}),
        agentId:
          trustedAgentRuntime?.agentId ??
          (sessionOwner?.ok ? sessionOwner.agentId : sanitizeMeta(p.agentId)),
        sessionKey,
        runId: trustedAgentRuntime?.operationalRunInstance.runId ?? null,
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
