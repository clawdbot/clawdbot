// Handles abort requests and active reply run cancellation.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { killAllControlledSubagentRuns } from "../../agents/subagents/registry/subagent-control.js";
import { listSubagentRunsForController } from "../../agents/subagents/registry/subagent-registry-read.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  type SessionAbortTargetContext,
  type SessionAbortTargetIdentity,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import {
  type AbortCutoff,
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
} from "./abort-cutoff.js";
import { isAbortRequestText, isAbortTrigger, setAbortMemory } from "./abort-primitives.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

export { isAbortRequestText, isAbortTrigger, setAbortMemory };

export function abortSessionRunTargetWithOutcome(params: { key?: string; sessionId?: string }): {
  active: boolean;
  aborted: boolean;
} {
  const sessionIds = new Set<string>();
  const key = normalizeOptionalString(params.key);
  let active = key ? replyRunRegistry.isActive(key) : false;
  if (key) {
    const activeSessionId = resolveActiveEmbeddedRunSessionId(key);
    if (activeSessionId) {
      active = true;
      sessionIds.add(activeSessionId);
    }
  }
  const explicitSessionId = normalizeOptionalString(params.sessionId);
  if (explicitSessionId) {
    sessionIds.add(explicitSessionId);
  }

  let aborted = key ? replyRunRegistry.abort(key) : false;
  for (const sessionId of sessionIds) {
    aborted = abortEmbeddedAgentRun(sessionId) || aborted;
  }
  return { active, aborted };
}

export function formatAbortReplyText(
  stoppedSubagents?: number,
  rejectionReason?: "finalizing",
  failedSubagents?: number,
): string {
  const failureSuffix =
    typeof failedSubagents === "number" && failedSubagents > 0
      ? ` Cancellation was incomplete for ${failedSubagents} sub-agent${failedSubagents === 1 ? "" : "s"}. Retry /stop.`
      : "";
  if (rejectionReason === "finalizing") {
    const base = "Agent reply is already finalizing and can no longer be aborted.";
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return `${base}${failureSuffix}`;
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `${base} Stopped ${stoppedSubagents} ${label}.${failureSuffix}`;
  }
  if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
    return `⚙️ Agent was aborted.${failureSuffix}`;
  }
  const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
  return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.${failureSuffix}`;
}

function resolveStoredSessionId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  try {
    return loadSessionEntry({
      agentId,
      clone: false,
      sessionKey: params.sessionKey,
      storePath,
    })?.sessionId;
  } catch {
    return undefined;
  }
}

function resolveBoundAcpAbortTargetSessionKey(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  activeSessionKey: string;
}): string | undefined {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  if (!bindingContext) {
    return undefined;
  }
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey: params.activeSessionKey,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

function normalizeRequesterSessionKey(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const cleaned = normalizeOptionalString(key);
  if (!cleaned) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: cleaned, alias, mainKey });
}

export async function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}): Promise<{ stopped: number; failed: number }> {
  const requesterKey = normalizeRequesterSessionKey(params.cfg, params.requesterSessionKey);
  if (!requesterKey) {
    await params.beforeKill?.();
    return { stopped: 0, failed: 0 };
  }
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: requesterKey,
    fallbackAgentId: params.requesterAgentId,
  });
  const result = await killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller: {
      controllerSessionKey: requesterKey,
      controllerAgentId,
      callerSessionKey: requesterKey,
      callerIsSubagent: isSubagentSessionKey(requesterKey),
      controlScope: "children",
    },
    runs: listSubagentRunsForController(requesterKey),
    suppressTaskDelivery: true,
    beforeKill: params.beforeKill,
  });
  if (result.status === "error") {
    logVerbose(`abort: failed to stop subagents for ${requesterKey}: ${result.error}`);
  }
  if (result.killed > 0) {
    logVerbose(`abort: stopped ${result.killed} subagent run(s) for ${requesterKey}`);
  }
  return { stopped: result.killed, failed: result.status === "error" ? result.failed : 0 };
}

export async function tryFastAbortFromMessage(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
}): Promise<{
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  stoppedSubagents?: number;
  failedSubagents?: number;
}> {
  const { ctx, cfg } = params;
  const commandSessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.ParentSessionKey);
  const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? commandSessionKey;
  const raw = stripStructuralPrefixes(ctx.commandText);
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  const stripped = isGroup
    ? stripMentions(
        raw,
        ctx,
        cfg,
        resolveSessionAgentId({
          sessionKey: targetKey ?? ctx.SessionKey ?? "",
          config: cfg,
        }),
      )
    : raw;
  const abortRequested = isAbortRequestText(stripped);
  if (!abortRequested) {
    return { handled: false, aborted: false };
  }

  const commandAuthorized = ctx.CommandAuthorized;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }

  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
    fallbackAgentId: ctx.AgentId,
  });
  const abortKey = targetKey ?? auth.from ?? auth.to;
  const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;

  if (targetKey) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const abortCutoffForTarget = (target: SessionAbortTargetContext): AbortCutoff | undefined =>
      shouldPersistAbortCutoff({
        commandSessionKey,
        targetSessionKey: target.sessionKey,
      })
        ? resolveAbortCutoffFromContext(ctx)
        : undefined;
    let resolvedAbortTarget: SessionAbortTargetIdentity | null = null;
    try {
      resolvedAbortTarget = resolveSessionAbortTarget({
        agentId,
        sessionKey: targetKey,
        storePath,
      });
    } catch (error) {
      logVerbose(
        `abort: failed to resolve abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
    }
    const resolvedTargetKey = resolvedAbortTarget?.sessionKey ?? targetKey;
    const conversationBoundAcpTargetKey = commandSessionKey
      ? resolveBoundAcpAbortTargetSessionKey({
          ctx,
          cfg,
          activeSessionKey: commandSessionKey,
        })
      : undefined;
    const boundAcpTargetKey = !isAcpSessionKey(resolvedTargetKey)
      ? conversationBoundAcpTargetKey
      : undefined;
    const abortTargetKeys = [resolvedTargetKey];
    if (boundAcpTargetKey && boundAcpTargetKey !== resolvedTargetKey) {
      abortTargetKeys.push(boundAcpTargetKey);
    }
    let aborted = false;
    let activeAbortRejected = false;
    const acpCancellations: Promise<void>[] = [];
    try {
      const { stopped, failed } = await stopSubagentsForRequester({
        cfg,
        requesterSessionKey,
        requesterAgentId: agentId,
        beforeKill: () => {
          try {
            const sourceAbortKey =
              commandSessionKey &&
              !abortTargetKeys.includes(commandSessionKey) &&
              conversationBoundAcpTargetKey &&
              abortTargetKeys.includes(conversationBoundAcpTargetKey)
                ? commandSessionKey
                : undefined;
            const sessionIdsByKey = new Map<string, string | undefined>(
              abortTargetKeys.map((abortTargetKey) => [
                abortTargetKey,
                replyRunRegistry.resolveSessionId(abortTargetKey) ??
                  (abortTargetKey === resolvedTargetKey
                    ? resolvedAbortTarget?.sessionId
                    : resolveStoredSessionId({ cfg, sessionKey: abortTargetKey })),
              ]),
            );
            for (const abortTargetKey of abortTargetKeys) {
              const outcome = abortSessionRunTargetWithOutcome({
                key: abortTargetKey,
                sessionId: sessionIdsByKey.get(abortTargetKey),
              });
              activeAbortRejected ||= outcome.active && !outcome.aborted;
              aborted = outcome.aborted || aborted;
            }
            const sourceSessionId = sourceAbortKey
              ? (replyRunRegistry.resolveSessionId(sourceAbortKey) ??
                resolveStoredSessionId({ cfg, sessionKey: sourceAbortKey }))
              : undefined;
            if (sourceAbortKey) {
              const outcome = abortSessionRunTargetWithOutcome({
                key: sourceAbortKey,
                sessionId: sourceSessionId,
              });
              activeAbortRejected ||= outcome.active && !outcome.aborted;
              aborted = outcome.aborted || aborted;
            }
            const cleared = clearSessionQueues(
              abortTargetKeys
                .flatMap((abortTargetKey) => [abortTargetKey, sessionIdsByKey.get(abortTargetKey)])
                .concat(sourceAbortKey, sourceSessionId),
            );
            if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
              logVerbose(
                `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
              );
            }
          } finally {
            // The tree already holds queued reservations. Initiate ACP without awaiting
            // either backend so native cleanup cannot delay signal-less ACP steer turns.
            const acpManager = getAcpSessionManager();
            for (const acpTargetKey of abortTargetKeys) {
              const resolution = acpManager.resolveSession({
                cfg,
                sessionKey: acpTargetKey,
                agentId: acpTargetKey === resolvedTargetKey ? agentId : undefined,
              });
              if (resolution.kind === "none") {
                continue;
              }
              acpCancellations.push(
                acpManager
                  .cancelSession({
                    cfg,
                    sessionKey: resolution.sessionKey,
                    agentId: resolution.agentId,
                    reason: "fast-abort",
                  })
                  .catch((error: unknown) => {
                    logVerbose(
                      `abort: ACP cancel failed for ${acpTargetKey}: ${formatErrorMessage(error)}`,
                    );
                  }),
              );
            }
          }
          return true;
        },
      });
      const rejectionReason = activeAbortRejected && !aborted ? "finalizing" : undefined;
      if (!rejectionReason) {
        let persistedAbortTarget: SessionAbortTargetResult | null = null;
        try {
          persistedAbortTarget = await markSessionAbortTarget({
            scope: {
              agentId,
              sessionKey: targetKey,
              storePath,
            },
            resolveAbortCutoff: abortCutoffForTarget,
          });
        } catch (error) {
          logVerbose(
            `abort: failed to persist abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
          );
        }
        if (persistedAbortTarget?.persisted === false) {
          logVerbose(
            `abort: failed to persist abort metadata for ${targetKey}: ${persistedAbortTarget.persistenceError ?? "unknown error"}`,
          );
        }
        const abortMemoryKey =
          persistedAbortTarget?.sessionKey ?? resolvedAbortTarget?.sessionKey ?? abortKey;
        const hasAbortTargetEntry = Boolean(
          persistedAbortTarget?.entry ?? resolvedAbortTarget?.entry,
        );
        if (persistedAbortTarget?.persisted !== true && abortMemoryKey && !hasAbortTargetEntry) {
          setAbortMemory(abortMemoryKey, true);
        }
      }
      return {
        handled: true,
        aborted,
        ...(rejectionReason ? { rejectionReason } : {}),
        stoppedSubagents: stopped,
        failedSubagents: failed,
      };
    } finally {
      // Join even when native signaling or metadata exits exceptionally.
      await Promise.all(acpCancellations);
    }
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  const { stopped, failed } = await stopSubagentsForRequester({ cfg, requesterSessionKey });
  return {
    handled: true,
    aborted: false,
    stoppedSubagents: stopped,
    failedSubagents: failed,
  };
}
