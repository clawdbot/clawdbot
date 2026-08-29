/**
 * sessions_send built-in tool.
 *
 * Sends messages to visible sessions, starts embedded runs, and optionally announces replies.
 */
import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  isSubagentSessionKey,
  normalizeAccountId,
  normalizeAgentId,
  normalizeAgentIdStrict,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import {
  isCronRunSessionKey,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { registerSessionStateWatch } from "../../sessions/session-state-events.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { listAgentIds, resolveSessionAgentId } from "../agent-scope.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../embedded-agent-runner/runs.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import { loadSessionEntryByKey } from "../subagents/announce/subagent-announce-delivery.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  isExpectedSessionLookupMiss,
  recordSessionToolActionFact,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  watch: Type.Optional(Type.Boolean()),
});

const log = createSubsystemLogger("agents/sessions-send");

const SessionsSendDeliverySchema = Type.Object(
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("skipped")]),
    mode: Type.Literal("announce"),
  },
  { additionalProperties: false },
);

const SessionsSendOutputSchema = Type.Union([
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
      sessionKey: Type.Optional(Type.String()),
      sentBeforeError: Type.Optional(Type.Literal(true)),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("accepted"),
      sessionKey: Type.String(),
      delivery: SessionsSendDeliverySchema,
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("timeout"),
      error: Type.String(),
      sentBeforeError: Type.Literal(true),
      sessionKey: Type.String(),
      delivery: Type.Optional(SessionsSendDeliverySchema),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("no_reply"),
      sessionKey: Type.String(),
      message: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("ok"),
      sessionKey: Type.String(),
      delivery: SessionsSendDeliverySchema,
      reply: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = AgentToolGatewayRequestCaller;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;
const NO_REPLY_MESSAGE = "No visible reply or pending announcement. Continue or retry if needed.";

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readToolStringParam(params, alias);
      if (value) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  mainKey: string;
}): boolean {
  if (isUnscopedSessionKeySentinel(params.sessionKey)) {
    return false;
  }
  if (params.sessionKey === params.mainKey) {
    return true;
  }
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  return agentId
    ? params.sessionKey ===
        resolveConfiguredAgentMainSessionKey({
          cfg: params.cfg,
          agentId,
          mainKey: params.mainKey,
        })
    : false;
}

async function createConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  agentId?: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const targetAgentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  try {
    const createParams = {
      key: params.sessionKey,
      agentId: targetAgentId,
    };
    if (
      params.useTrustedInProcessCreation &&
      params.requesterSessionKey &&
      hasInProcessGatewayToolContext()
    ) {
      // sessions.create serializes keyed creation and adopts an existing row,
      // so concurrent first sends can safely race after the missing resolution.
      await callInProcessGatewayToolWithCreation("sessions.create", createParams, {
        via: "internal",
        actor: { type: "agent", id: params.requesterSessionKey },
      });
    } else {
      await params.callGateway({
        method: "sessions.create",
        params: createParams,
        timeoutMs: 10_000,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

type SessionsSendRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta?: unknown;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    !isSubagentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}

function isTerminalAgentWaitTimeout(result: AgentWaitResult): boolean {
  return result.endedAt !== undefined || Boolean(result.stopReason || result.livenessState);
}

function isPendingErrorAgentWaitTimeout(result: AgentWaitResult): boolean {
  return (
    result.pendingError === true && typeof result.error === "string" && result.error.trim() !== ""
  );
}

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  if (!fallbackRest) {
    return undefined;
  }
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued &&
    (outcome.reason === "not_streaming" ||
      outcome.reason === "no_active_run" ||
      outcome.reason === "stale_run")
  );
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
  allowActiveRunQueueFallback?: boolean;
  expectedSessionId?: string;
}): Promise<
  | {
      ok: true;
      runId: string;
      activeRunQueue?: boolean;
      a2aSessionKey?: string;
      a2aDisplayKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  try {
    const activeRunSessionId =
      params.allowActiveRunQueueDelivery && isRunScopedAgentSessionKey(params.sessionKey)
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    if (
      activeRunSessionId &&
      params.expectedSessionId &&
      activeRunSessionId !== params.expectedSessionId
    ) {
      throw new Error("active run session incarnation changed");
    }
    const messageText =
      typeof params.sendParams.message === "string" ? params.sendParams.message : undefined;
    if (activeRunSessionId && messageText) {
      const sourceReplyDeliveryMode =
        params.sendParams.sourceReplyDeliveryMode === "automatic" ||
        params.sendParams.sourceReplyDeliveryMode === "message_tool_only"
          ? params.sendParams.sourceReplyDeliveryMode
          : undefined;
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      };
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
        );
      }
      if (queueOutcome.queued) {
        return { ok: true, runId: params.runId, activeRunQueue: true };
      }
      const fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.allowActiveRunQueueFallback !== false &&
        fallbackSessionKey &&
        shouldFallbackCronRunScopedActiveDelivery(queueOutcome)
      ) {
        const response = await params.callGateway<{ runId: string }>({
          method: "agent",
          params: {
            ...params.sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
        return {
          ok: true,
          runId:
            typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
          a2aSessionKey: fallbackSessionKey,
          a2aDisplayKey: fallbackSessionKey,
        };
      }
      const queueSummary =
        formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected";
      throw new Error(queueSummary);
    }
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  /** Backend-derived target incarnation; never sourced from model arguments. */
  expectedTargetSessionId?: string;
  /** Backend-owned downstream operation id; never sourced from model arguments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: async (_toolCallId, args) => {
      const promptedAt = Date.now();
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const message = readToolStringParam(params, "message", { required: true });
      const timeoutSeconds = readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30;
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      let requesterAgentId: string;
      try {
        requesterAgentId = resolveSessionAgentId({
          config: cfg,
          sessionKey: effectiveRequesterKey,
          agentId: opts?.agentId,
        });
      } catch (err) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: formatErrorMessage(err),
        });
      }

      const sessionKeyParam = readToolStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readToolStringParam(params, "label"));
      const labelAgentIdInput = readToolStringParam(params, "agentId");
      const normalizedLabelAgentId =
        labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
      if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
        });
      }
      const explicitTargetAgentId = normalizedLabelAgentId?.value;

      let sessionKey = sessionKeyParam;
      let resolvedTargetAgentId: string | undefined;
      let resolvedLabelKey: string | undefined;
      if (!sessionKey && !labelParam && explicitTargetAgentId) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: explicitTargetAgentId,
          mainKey,
        });
        if (!agentMainKey) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
          });
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requestedAgentId = explicitTargetAgentId;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey;
        try {
          const resolved = await gatewayCall<{ agentId?: string; key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
          resolvedTargetAgentId = normalizeOptionalString(resolved?.agentId);
        } catch (err) {
          if (isExpectedSessionLookupMiss(err)) {
            resolvedKey = "";
          } else {
            const failure = sessionOwnershipLookupFailure(err);
            logSessionOwnershipLookupFailure({
              requesterSessionKey: effectiveRequesterKey,
              failure,
            });
            return jsonResult({
              runId: crypto.randomUUID(),
              status: restrictToSpawned ? "forbidden" : "error",
              error: restrictToSpawned
                ? lookupFailedDenialMessage("send", failure.kind)
                : lookupFailedOperationMessage("send", failure.kind),
            });
          }
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
        resolvedLabelKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const allowMissingKey = isConfiguredAgentMainSessionKey({
        cfg,
        sessionKey,
        mainKey,
      });
      const resolvedSession = resolvedLabelKey
        ? {
            ok: true as const,
            ...(resolvedTargetAgentId ? { agentId: resolvedTargetAgentId } : {}),
            key: resolvedLabelKey,
            displayKey: resolveDisplaySessionKey({ key: resolvedLabelKey, alias, mainKey }),
            resolvedViaSessionId: false,
            requesterOwned: restrictToSpawned,
          }
        : await resolveSessionReference({
            action: "send",
            sessionKey,
            keyAgentId: requesterAgentId,
            alias,
            mainKey,
            requesterInternalKey: effectiveRequesterKey,
            restrictToSpawned,
            callGateway: gatewayCall,
          });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const resolutionAccess = createSessionVisibilityRowChecker({
        action: "send",
        defaultAgentId:
          resolvedSession.agentId ??
          resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility: sessionVisibility,
        a2aPolicy,
      }).check({ key: resolvedSession.key });
      const visibleSession = await resolveVisibleSessionReference({
        action: "send",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
        allowMissingKey,
        concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
        callGateway: gatewayCall,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const resolvedKeyAgentId = parseAgentSessionKey(resolvedKey)?.agentId;
      const isLiteralLegacyKeyInput =
        !labelParam && sessionKeyParam !== undefined && !resolvedSession.resolvedViaSessionId;
      const isLiteralUnscopedTarget =
        isLiteralLegacyKeyInput && classifySessionKeyShape(resolvedKey) === "legacy_or_alias";
      const persistedTargetOwner = isLiteralUnscopedTarget
        ? resolvePersistedSessionStoreOwnerForKey(cfg, resolvedKey)
        : { kind: "none" as const };
      const compatibilityTargetAgentId =
        isLiteralUnscopedTarget && persistedTargetOwner.kind === "none"
          ? tryResolveLegacyCompatibilityAgentId(cfg)
          : undefined;
      const isLiteralUnscopedMainTarget =
        isLiteralUnscopedTarget &&
        (isUnscopedSessionKeySentinel(sessionKeyParam.trim()) ||
          sessionKeyParam.trim().toLowerCase() === mainKey);
      if (persistedTargetOwner.kind === "retired") {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: "Session ownership could not be verified because its fixed-store owner retired.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const resolvedTargetOwner =
        visibleSession.agentId ??
        resolvedTargetAgentId ??
        (labelParam ? explicitTargetAgentId : undefined);
      if (
        persistedTargetOwner.kind === "configured" &&
        resolvedTargetOwner &&
        normalizeAgentId(resolvedTargetOwner) !== persistedTargetOwner.agentId
      ) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: `Session belongs to agent "${persistedTargetOwner.agentId}", not "${normalizeAgentId(resolvedTargetOwner)}".`,
          sessionKey: unresolvedDisplayKey,
        });
      }
      const targetAgentId =
        (persistedTargetOwner.kind === "configured" ? persistedTargetOwner.agentId : undefined) ??
        resolvedTargetOwner ??
        resolvedKeyAgentId ??
        (isLiteralUnscopedMainTarget ? requesterAgentId : undefined) ??
        compatibilityTargetAgentId;
      if (!targetAgentId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error:
            "Session ownership could not be verified. Upgrade the gateway or use an agent-prefixed session key.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const mayUseRequesterForLiteralSentinel =
        isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId;
      const rawRequesterSessionKey = opts?.agentSessionKey ? effectiveRequesterKey : undefined;
      const parsedRequesterSessionKey = parseAgentSessionKey(rawRequesterSessionKey);
      const requesterRouteBindings = cfg.bindings?.filter(
        (binding): binding is AgentRouteBinding => binding.type !== "acp",
      );
      const requesterDeliveryRoute = requesterRouteBindings?.length
        ? parseSessionDeliveryRoute(rawRequesterSessionKey)
        : null;
      const bareRequesterPeerId = parsedRequesterSessionKey?.rest.startsWith("direct:")
        ? parsedRequesterSessionKey.rest.slice("direct:".length)
        : parsedRequesterSessionKey?.rest.startsWith("dm:")
          ? parsedRequesterSessionKey.rest.slice("dm:".length)
          : undefined;
      const requesterRouteChannel = requesterDeliveryRoute?.channel ?? opts?.agentChannel;
      const requesterRoutePeerId = requesterDeliveryRoute?.peerId ?? bareRequesterPeerId;
      const requesterRoute =
        requesterRouteBindings?.length && requesterRouteChannel && requesterRoutePeerId
          ? resolveAgentRoute({
              cfg,
              channel: requesterRouteChannel,
              accountId: requesterDeliveryRoute?.accountId,
              peer: { kind: "direct", id: requesterRoutePeerId },
            })
          : undefined;
      // Any configured route can transfer this peer to another agent. A key
      // without enough route facts must never be reassigned to guessed ownership.
      const hasUnresolvedRequesterRoute = Boolean(
        requesterRouteBindings?.length &&
        (!requesterRoute || requesterRoute.agentId !== parsedRequesterSessionKey?.agentId),
      );
      // Session keys can discard account, peer casing, team, guild, and roles.
      // Preserve the authenticated caller whenever any possible binding would
      // choose another agent or an isolated DM scope using those missing facts.
      const hasUnsafeRequesterDmBinding = Boolean(
        requesterRouteBindings?.some((binding) => {
          const effectiveDmScope = binding.session?.dmScope ?? cfg.session?.dmScope ?? "main";
          const isForeignAgent =
            normalizeAgentId(binding.agentId) !== parsedRequesterSessionKey?.agentId;
          if (!isForeignAgent && effectiveDmScope === "main") {
            return false;
          }
          if (
            requesterRouteChannel &&
            normalizeRouteBindingChannelId(binding.match.channel) !==
              normalizeRouteBindingChannelId(requesterRouteChannel)
          ) {
            return false;
          }
          const bindingAccountId = binding.match.accountId?.trim();
          if (
            requesterDeliveryRoute?.accountId &&
            bindingAccountId !== "*" &&
            normalizeAccountId(bindingAccountId) !==
              normalizeAccountId(requesterDeliveryRoute.accountId)
          ) {
            return false;
          }
          const peer = binding.match.peer;
          if (peer) {
            const peerId = peer.id.trim();
            if (
              peer.kind !== "direct" ||
              (peerId !== "*" &&
                peerId.toLowerCase() !== requesterRoutePeerId?.trim().toLowerCase())
            ) {
              return false;
            }
          }
          return true;
        }),
      );
      const requesterDmScope =
        requesterRoute && requesterRoute.agentId === parsedRequesterSessionKey?.agentId
          ? (requesterRoute.dmScope ?? cfg.session?.dmScope ?? "main")
          : (cfg.session?.dmScope ?? "main");
      // Normalize legacy DM reply addresses only after exact-key visibility
      // checks; global/binding-isolated DMs and non-DM owners stay private.
      const requesterSessionKey = rawRequesterSessionKey;
      const replyRequesterSessionKey =
        rawRequesterSessionKey &&
        parsedRequesterSessionKey &&
        rawRequesterSessionKey !== resolvedKey &&
        requesterDmScope === "main" &&
        !hasUnresolvedRequesterRoute &&
        !hasUnsafeRequesterDmBinding &&
        !parsedRequesterSessionKey.rest.startsWith("cron:") &&
        !parsedRequesterSessionKey.rest.startsWith("hook:") &&
        !isSubagentSessionKey(rawRequesterSessionKey) &&
        !parseSessionThreadInfo(rawRequesterSessionKey).threadId &&
        deriveSessionChatTypeFromKey(rawRequesterSessionKey) === "direct"
          ? buildAgentMainSessionKey({
              agentId: parsedRequesterSessionKey.agentId,
              mainKey,
            })
          : rawRequesterSessionKey;
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = opts?.idempotencyKey ?? crypto.randomUUID();
      let runId: string = idempotencyKey;
      // Fire-and-forget self-send remains a channel-delivery path. A synchronous
      // self-send would wait behind its own active session lane until timeout.
      if (
        timeoutSeconds !== 0 &&
        requesterSessionKey === resolvedKey &&
        targetAgentId === requesterAgentId
      ) {
        return jsonResult({
          runId,
          status: "error",
          error: "sessions_send cannot target the calling session; use your own reply instead",
          sessionKey: unresolvedDisplayKey,
        });
      }
      if (parseSessionThreadInfo(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const authorizationTargetKey = mayUseRequesterForLiteralSentinel
        ? effectiveRequesterKey
        : targetAgentId && !parseAgentSessionKey(resolvedKey)
          ? `agent:${targetAgentId}:${resolvedKey}`
          : resolvedKey;
      const access = await resolveSessionToolAccess({
        action: "send",
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        targetAgentId,
        targetSessionKey: resolvedKey,
        authorizationTargetSessionKey: authorizationTargetKey,
        requesterOwned: visibleSession.requesterOwned,
        visibility: sessionVisibility,
        a2aPolicy,
        callGateway: gatewayCall,
      });
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: formatSessionToolAccessDenial(access, {
            action: "send",
            targetSessionKey: unresolvedDisplayKey,
          }),
          sessionKey: unresolvedDisplayKey,
        });
      }
      const expectedSessionId = opts?.expectedTargetSessionId ?? access.expectedSessionId;

      return await runWithScopedSessionAccess({
        cfg,
        agentId: targetAgentId,
        expectedSessionId,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        targetSessionKey: resolvedKey,
        run: async () => {
          if (visibleSession.missing) {
            const createdSession = await createConfiguredAgentMainSession({
              cfg,
              callGateway: gatewayCall,
              ...(targetAgentId ? { agentId: targetAgentId } : {}),
              sessionKey: resolvedKey,
              requesterSessionKey,
              useTrustedInProcessCreation: opts?.callGateway === undefined,
            });
            if (!createdSession.ok) {
              return jsonResult({
                runId: crypto.randomUUID(),
                status: "error",
                error: createdSession.error,
                sessionKey: displayKey,
              });
            }
          }

          const requesterChannel = opts?.agentChannel;
          const sameSessionA2A =
            requesterSessionKey === resolvedKey && targetAgentId === requesterAgentId;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          // Watch registration follows successful dispatch: a failed send must not leave
          // a hidden watch, and cron run-scoped sends can fall back to the durable parent
          // session, which is the key that receives future state changes.
          const watchRequested = params.watch === true;
          const registerWatchIfRequested = (targetSessionKey: string) => {
            const watched =
              watchRequested &&
              !expectedSessionId &&
              replyRequesterSessionKey &&
              replyRequesterSessionKey !== targetSessionKey
                ? registerSessionStateWatch({
                    watcherSessionKey: replyRequesterSessionKey,
                    targetSessionKey,
                    targetAgentId,
                  })
                : false;
            return watchRequested ? { watched } : {};
          };
          const fallbackA2ASessionKey =
            timeoutSeconds === 0 && isIsolatedCronRequester
              ? resolveCronRunScopedFallbackSessionKey(displayKey)
              : undefined;

          // Capture the pre-run assistant snapshot before starting the nested run.
          // Fast in-process test doubles and short-circuit agent paths can finish
          // before we reach the post-run read, which would otherwise make the new
          // reply look like the baseline and hide it from the caller.
          // Fire-and-forget same-session sends still need this baseline because the
          // A2A follow-up may deliver directly to the source channel. Isolated cron
          // requesters also need it to avoid attributing a stale target reply.
          const baselineReply =
            timeoutSeconds !== 0
              ? await readLatestAssistantReplySnapshot({
                  sessionKey: resolvedKey,
                  agentId: targetAgentId,
                  limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                  callGateway: gatewayCall,
                })
              : sameSessionA2A || isIsolatedCronRequester
                ? await readLatestAssistantReplySnapshot({
                    sessionKey: resolvedKey,
                    agentId: targetAgentId,
                    limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                    callGateway: gatewayCall,
                  }).catch(() => undefined)
                : undefined;
          // Active-run delivery can fall back to the durable cron parent. Snapshot
          // that target before dispatch so a fast reply cannot become its baseline.
          const fallbackBaselineReply =
            fallbackA2ASessionKey && fallbackA2ASessionKey !== resolvedKey
              ? await readLatestAssistantReplySnapshot({
                  sessionKey: fallbackA2ASessionKey,
                  agentId: targetAgentId,
                  limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                  callGateway: gatewayCall,
                }).catch(() => undefined)
              : undefined;

          const agentMessageContext = buildAgentToAgentMessageContext({
            requesterSessionKey: replyRequesterSessionKey,
            requesterChannel,
            targetSessionKey: displayKey,
          });
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: replyRequesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
          };
          const sendParams = {
            message: annotateInterSessionPromptText(message, inputProvenance),
            agentId: targetAgentId,
            sessionKey: resolvedKey,
            idempotencyKey,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only" as const,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: resolveNestedAgentLaneForSession(resolvedKey),
            extraSystemPrompt: agentMessageContext,
            inputProvenance,
          };
          const maxPingPongTurns = resolvePingPongTurns();

          // Skip the A2A ping-pong + announce flow when the current caller is the
          // parent of a parent-owned child session it spawned itself and another
          // parent-visible result path already exists.
          //
          // ACP background sessions report through the internal task completion
          // path. Waited native subagent sends return the child reply inline. In
          // both cases treating the child as a peer agent wakes the parent with
          // the child's reply, can generate another user-facing response, and can
          // forward that response back to the child as a new message — producing a
          // ping-pong loop (bounded by maxPingPongTurns, but visible as duplicate
          // conversation output).
          //
          // The skip is gated on requester ownership, not just target type: an
          // unrelated sender that can see the same target (e.g. under
          // `tools.sessions.visibility=all`) must still go through the normal A2A
          // path so it actually receives a follow-up delivery.
          const targetSessionEntry = loadSessionEntryByKey(resolvedKey, targetAgentId);
          const targetAcpMeta = readAcpSessionMeta({
            sessionKey: resolvedKey,
            agentId: targetAgentId,
            cfg,
          });
          const targetSessionEntryWithAcp =
            targetAcpMeta && targetSessionEntry
              ? { ...targetSessionEntry, acp: targetAcpMeta }
              : targetSessionEntry;
          const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(
            targetSessionEntryWithAcp,
            effectiveRequesterKey,
          );
          const skipNativeParentA2AFlow =
            timeoutSeconds !== 0 &&
            isRequesterParentOfNativeSubagentSession({
              entry: targetSessionEntry,
              acpMeta: targetAcpMeta,
              requesterSessionKey: effectiveRequesterKey,
              targetSessionKey: resolvedKey,
            });
          // A scoped grant belongs to one exact session incarnation. Do not create
          // post-return work or durable watches that could follow a reused key.
          const skipA2AFlow =
            skipAcpA2AFlow || skipNativeParentA2AFlow || Boolean(expectedSessionId);
          // When the A2A flow is skipped, no follow-up announcement will fire and
          // the reply (when present) is returned inline via the `reply` field.
          // Reflect that in the metadata so the parent LLM does not wait for a
          // second result that will never arrive.
          const delivery = skipA2AFlow
            ? ({ status: "skipped", mode: "announce" } as const)
            : ({ status: "pending", mode: "announce" } as const);

          const startA2AFlow = (
            roundOneReply?: string,
            waitRunId?: string,
            flowTargetSessionKey = resolvedKey,
            flowDisplayKey = displayKey,
            notifyRequesterOnWaitFailure = false,
          ) => {
            if (skipA2AFlow) {
              return;
            }
            const flowBaseline =
              flowTargetSessionKey === fallbackA2ASessionKey
                ? fallbackBaselineReply
                : baselineReply;
            // This detached flow can outlive the tool request that launched it.
            // Own a fresh root so parent release cannot retire later nested turns.
            void runWithGatewayIndependentRootWorkContinuation(() =>
              runWithoutOwnedSessionTranscriptWrites(() =>
                runSessionsSendA2AFlow({
                  callGateway: gatewayCall,
                  targetSessionKey: flowTargetSessionKey,
                  targetAgentId,
                  displayKey: flowDisplayKey,
                  message,
                  announceTimeoutMs,
                  // Cron runs are isolated jobs; target replies must not become new
                  // requester turns, but the target-side announce still runs.
                  maxPingPongTurns: isIsolatedCronRequester ? 0 : maxPingPongTurns,
                  requesterSessionKey: replyRequesterSessionKey,
                  requesterAgentId,
                  requesterChannel,
                  baseline: flowBaseline,
                  roundOneReply,
                  waitRunId,
                  notifyRequesterOnWaitFailure,
                }),
              ),
            ).catch((err: unknown) => {
              log.warn("sessions_send announce flow admission failed", {
                runId: waitRunId ?? "unknown",
                error: formatErrorMessage(err),
              });
            });
          };

          const start = await startAgentRun({
            callGateway: gatewayCall,
            runId,
            sendParams,
            sessionKey: displayKey,
            deliveryTimeoutMs: announceTimeoutMs,
            ...(timeoutSeconds === 0
              ? {
                  allowActiveRunQueueDelivery: true,
                  // An exact-incarnation grant authorizes only this target. Never
                  // reroute a worker-owned send to a durable Cron parent outside
                  // the scoped lifecycle admission or replace its stable key.
                  allowActiveRunQueueFallback: !expectedSessionId,
                  expectedSessionId,
                }
              : {}),
          });
          if (!start.ok) {
            return start.result;
          }
          const acceptedTargetSessionKey = start.a2aSessionKey ?? resolvedKey;
          recordSessionToolActionFact({
            operation: "send",
            fact: "committed",
            targetAgentId,
            targetSessionKey: acceptedTargetSessionKey,
          });
          recordSessionParticipantBestEffort({
            identity: { type: "agent", id: requesterAgentId },
            promptedAt,
            agentId: targetAgentId,
            sessionKey: acceptedTargetSessionKey,
            storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
            onError: (error) => log.warn("failed to record session participant", { error }),
          });
          runId = start.runId;
          const watchField = registerWatchIfRequested(acceptedTargetSessionKey);
          if (timeoutSeconds === 0) {
            if (!start.activeRunQueue) {
              startA2AFlow(undefined, runId, start.a2aSessionKey, start.a2aDisplayKey, true);
            }
            return jsonResult({
              runId,
              status: "accepted",
              sessionKey: displayKey,
              delivery,
              ...watchField,
            });
          }

          const result = await waitForAgentRunAndReadUpdatedAssistantReply({
            runId,
            sessionKey: resolvedKey,
            agentId: targetAgentId,
            timeoutMs,
            limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
            baseline: baselineReply,
            callGateway: gatewayCall,
          });

          if (result.status === "timeout") {
            if (isPendingErrorAgentWaitTimeout(result)) {
              startA2AFlow(undefined, runId);
              return jsonResult({
                runId,
                status: "timeout",
                error: result.error,
                sentBeforeError: true,
                sessionKey: displayKey,
                delivery,
                ...watchField,
              });
            }
            if (!isTerminalAgentWaitTimeout(result)) {
              startA2AFlow(undefined, runId, resolvedKey, displayKey, true);
              return jsonResult({
                runId,
                status: "accepted",
                sessionKey: displayKey,
                delivery,
                ...watchField,
              });
            }
            return jsonResult({
              runId,
              status: "timeout",
              error: result.error ?? "agent run timed out",
              sentBeforeError: true,
              sessionKey: displayKey,
              ...watchField,
            });
          }
          if (result.status === "error") {
            return jsonResult({
              runId,
              status: "error",
              error: result.error ?? "agent error",
              sentBeforeError: true,
              sessionKey: displayKey,
              ...watchField,
            });
          }
          const reply = result.replyText;
          const response = reply
            ? { status: "ok" as const, delivery, reply }
            : { status: "no_reply" as const, message: NO_REPLY_MESSAGE };
          if (reply) {
            startA2AFlow(reply);
          }
          return jsonResult({ runId, sessionKey: displayKey, ...response, ...watchField });
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
