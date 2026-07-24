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
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { registerSessionStateWatch } from "../../sessions/session-state-events.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { listAgentIds } from "../agent-scope.js";
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
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNonNegativeIntegerParam, readStringParam } from "./common.js";
import {
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
} from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
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
      status: Type.Literal("ok"),
      sessionKey: Type.String(),
      delivery: SessionsSendDeliverySchema,
      reply: Type.Optional(Type.String()),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readStringParam(params, alias);
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
  sessionKey: string;
  mainKey: string;
}): boolean {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  return (
    params.sessionKey ===
    resolveConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      agentId,
      mainKey: params.mainKey,
    })
  );
}

async function ensureConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  sessionKey: string;
  mainKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (
    !isConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    })
  ) {
    return { ok: true };
  }

  try {
    await params.callGateway({
      method: "sessions.resolve",
      params: { key: params.sessionKey },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch {
    try {
      const createParams = {
        key: params.sessionKey,
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
      };
      if (
        params.useTrustedInProcessCreation &&
        params.requesterSessionKey &&
        hasInProcessGatewayToolContext()
      ) {
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
      if (fallbackSessionKey && shouldFallbackCronRunScopedActiveDelivery(queueOutcome)) {
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
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
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
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30;
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));

      let sessionKey = sessionKeyParam;
      if (!sessionKey && !labelParam && labelAgentIdParam) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: labelAgentIdParam,
          mainKey,
        });
        if (!agentMainKey) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `agent not found: ${labelAgentIdParam}`,
          });
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

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
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
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
            error: msg || `No session found with label: ${labelParam}`,
          });
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
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        action: "send",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
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
      const requesterSessionKey = opts?.agentSessionKey ? effectiveRequesterKey : undefined;
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      // Fire-and-forget self-send remains a channel-delivery path. A synchronous
      // self-send would wait behind its own active session lane until timeout.
      if (timeoutSeconds !== 0 && requesterSessionKey === resolvedKey) {
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
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: unresolvedDisplayKey,
        });
      }

      return await runWithScopedSessionAccess({
        cfg,
        expectedSessionId: access.expectedSessionId,
        targetSessionKey: resolvedKey,
        run: async () => {
          const ensuredSession = await ensureConfiguredAgentMainSession({
            cfg,
            callGateway: gatewayCall,
            sessionKey: resolvedKey,
            mainKey,
            requesterSessionKey,
            useTrustedInProcessCreation: opts?.callGateway === undefined,
          });
          if (!ensuredSession.ok) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "error",
              error: ensuredSession.error,
              sessionKey: displayKey,
            });
          }

          const requesterChannel = opts?.agentChannel;
          const sameSessionA2A = requesterSessionKey === resolvedKey;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          // Watch registration follows successful dispatch: a failed send must not leave
          // a hidden watch, and cron run-scoped sends can fall back to the durable parent
          // session, which is the key that receives future state changes.
          const watchRequested = params.watch === true;
          const registerWatchIfRequested = (targetSessionKey: string) => {
            const watched =
              watchRequested &&
              !access.expectedSessionId &&
              requesterSessionKey &&
              requesterSessionKey !== targetSessionKey
                ? registerSessionStateWatch({
                    watcherSessionKey: requesterSessionKey,
                    targetSessionKey,
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
                  limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                  callGateway: gatewayCall,
                })
              : sameSessionA2A || isIsolatedCronRequester
                ? await readLatestAssistantReplySnapshot({
                    sessionKey: resolvedKey,
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
                  limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                  callGateway: gatewayCall,
                }).catch(() => undefined)
              : undefined;

          const agentMessageContext = buildAgentToAgentMessageContext({
            requesterSessionKey,
            requesterChannel,
            targetSessionKey: displayKey,
          });
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
          };
          const sendParams = {
            message: annotateInterSessionPromptText(message, inputProvenance),
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
          const targetSessionEntry = loadSessionEntryByKey(resolvedKey);
          const targetAcpMeta = readAcpSessionMeta({ sessionKey: resolvedKey });
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
            skipAcpA2AFlow || skipNativeParentA2AFlow || Boolean(access.expectedSessionId);
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
            void runSessionsSendA2AFlow({
              targetSessionKey: flowTargetSessionKey,
              displayKey: flowDisplayKey,
              message,
              announceTimeoutMs,
              // Cron runs are isolated jobs; target replies must not become new
              // requester turns, but the target-side announce still runs.
              maxPingPongTurns: isIsolatedCronRequester ? 0 : maxPingPongTurns,
              requesterSessionKey,
              requesterChannel,
              baseline: flowBaseline,
              roundOneReply,
              waitRunId,
              notifyRequesterOnWaitFailure,
            });
          };

          if (timeoutSeconds === 0) {
            const start = await startAgentRun({
              callGateway: gatewayCall,
              runId,
              sendParams,
              sessionKey: displayKey,
              deliveryTimeoutMs: announceTimeoutMs,
              allowActiveRunQueueDelivery: true,
            });
            if (!start.ok) {
              return start.result;
            }
            runId = start.runId;
            const watchField = registerWatchIfRequested(start.a2aSessionKey ?? resolvedKey);
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

          const start = await startAgentRun({
            callGateway: gatewayCall,
            runId,
            sendParams,
            sessionKey: displayKey,
            deliveryTimeoutMs: announceTimeoutMs,
          });
          if (!start.ok) {
            return start.result;
          }
          runId = start.runId;
          const watchField = registerWatchIfRequested(resolvedKey);
          const result = await waitForAgentRunAndReadUpdatedAssistantReply({
            runId,
            sessionKey: resolvedKey,
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
              error: result.error,
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
          startA2AFlow(reply ?? undefined);

          return jsonResult({
            runId,
            status: "ok",
            sessionKey: displayKey,
            delivery,
            ...(typeof reply === "string" ? { reply } : {}),
            ...watchField,
          });
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
