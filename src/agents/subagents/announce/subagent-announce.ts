/** Coordinates child output capture, completion routing, and cleanup. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { defaultRuntime } from "../../../runtime.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  finalizeDelegateArtifacts,
  isDelegateArtifactReturnConfigured,
  prepareDelegateArtifactDelivery,
  type DelegateArtifactRecipientProjectionV1,
} from "../../delegate-artifacts.js";
import {
  buildSubagentAnnounceMessages,
  type SubagentAnnounceType,
} from "../../subagent-announce-message.js";
import {
  normalizeSubagentAnnounceReply,
  warnIfCronAnnounceSkipped,
} from "../../subagent-announce-reply.js";
import { isAnnounceSkip } from "../../tools/sessions-send-tokens.js";
import {
  countPendingDescendantRuns,
  getLatestSubagentRunByChildSessionKey,
  isSubagentSessionRunActive,
  listAncestorSessionKeys,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "../registry/subagent-registry-read.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
} from "./subagent-announce-delivery.js";
import {
  hasUsableSessionEntry,
  isWakeContinuationRun,
  stripWakeRunSuffixes,
  wakeSubagentRunAfterDescendants,
} from "./subagent-announce-descendant-wake.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  readSubagentTimeoutProgress,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  resolveContinuationRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";
import type { SubagentRunOutcome } from "./subagent-run-outcome.js";
type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
  resolveContinuationRuntimeConfig: typeof resolveContinuationRuntimeConfig;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
  resolveContinuationRuntimeConfig,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("../registry/subagent-registry-runtime.js"),
);
const subagentContinuationRuntimeLoader = createLazyImportLoader(
  () => import("../../subagent-announce.continuation.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

export { buildSubagentSystemPrompt } from "../spawn/subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export { hasUsableSessionEntry } from "./subagent-announce-descendant-wake.js";
export type { SubagentAnnounceType } from "../../subagent-announce-message.js";
export type { SubagentRunOutcome } from "./subagent-run-outcome.js";
export type SubagentAnnounceFlowOutcome = NonNullable<
  SubagentAnnounceDeliveryResult["disposition"]
>;

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  /** Deliver only frozen terminal facts; never inspect or mutate the child session. */
  suppressChildSessionEffects?: boolean;
  /** Live owner check for child-session effects after awaited phases. */
  isChildSessionEffectsAllowed?: () => boolean;
  /** Live owner check for requester delivery after awaited phases. */
  isCompletionDeliveryAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  silentAnnounce?: boolean;
  wakeOnReturn?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
  onBeforeDeleteChildSession?: () => boolean;
}): Promise<SubagentAnnounceFlowOutcome> {
  let announceOutcome: SubagentAnnounceFlowOutcome = "retryable";
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  const childSessionEffectsAllowed = () =>
    params.suppressChildSessionEffects !== true &&
    params.isChildSessionEffectsAllowed?.() !== false;
  const completionDeliveryAllowed = () => params.isCompletionDeliveryAllowed?.() !== false;
  let childSessionId: string | undefined;
  let childSessionLifecycleRevision: string | undefined;
  try {
    const sessionEntryCache = new Map<string, ReturnType<typeof loadSessionEntryByKey>>();
    const requesterEntryCache = new Map<string, ReturnType<typeof loadRequesterSessionEntry>>();
    const readSessionEntryByKey = (sessionKey: string, options?: { refresh?: boolean }) => {
      if (options?.refresh || !sessionEntryCache.has(sessionKey)) {
        sessionEntryCache.set(sessionKey, loadSessionEntryByKey(sessionKey));
      }
      return sessionEntryCache.get(sessionKey);
    };
    const readRequesterSessionEntry = (sessionKey: string, options?: { refresh?: boolean }) => {
      if (options?.refresh || !requesterEntryCache.has(sessionKey)) {
        requesterEntryCache.set(sessionKey, loadRequesterSessionEntry(sessionKey));
      }
      return requesterEntryCache.get(sessionKey)!;
    };
    const invalidateSessionEntry = (sessionKey: string) => {
      sessionEntryCache.delete(sessionKey);
      requesterEntryCache.delete(sessionKey);
    };
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionEntry = !childSessionEffectsAllowed()
      ? undefined
      : readSessionEntryByKey(params.childSessionKey);
    childSessionId =
      typeof childSessionEntry?.sessionId === "string" && childSessionEntry.sessionId.trim()
        ? childSessionEntry.sessionId.trim()
        : undefined;
    childSessionLifecycleRevision = normalizeOptionalString(childSessionEntry?.lifecycleRevision);
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply =
      params.terminalReply?.disposition === "visible"
        ? params.terminalReply.text
        : params.terminalReply?.disposition === "silent"
          ? SILENT_REPLY_TOKEN
          : params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return "retryable";
        }
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }
    const failedTerminalOutcome = outcome.status === "error";
    const allowFailedOutputCapture =
      !failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply);
    if (failedTerminalOutcome && !params.terminalReply) {
      reply = undefined;
    }
    const managedArtifactReturn =
      childSessionEffectsAllowed() &&
      params.childRunId.startsWith("continuation-delegate-") &&
      isDelegateArtifactReturnConfigured(params.childRunId);
    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);
    // Keep this aligned with the targeted-return router. Any explicit target,
    // plural target set, or fanout mode must reach that router even if the
    // immediate requester has already been cleaned up.
    const hasTargeting = Boolean(
      params.continuationTargetSessionKey ||
      (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
      params.continuationFanoutMode,
    );

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      if (requesterIsInternalSession()) {
        if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
          // A cleaned-up intermediate child normally must not receive a late
          // ordinary completion announcement. A tree continuation return is
          // different: its ancestor set is resolved from that intermediate
          // child, so dropping here strands a completed grandchild before the
          // targeted-return router can deliver to the root.
          if (
            !hasTargeting &&
            !managedArtifactReturn &&
            shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)
          ) {
            return "delivered";
          }
          if (!hasUsableSessionEntry(readSessionEntryByKey(targetRequesterSessionKey))) {
            const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
            if (!fallback?.requesterSessionKey) {
              shouldDeleteChildSession = false;
              return "retryable";
            }
            targetRequesterSessionKey = fallback.requesterSessionKey;
            targetRequesterOrigin =
              normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
            requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          }
        }
      }

      const pendingChildDescendantRuns = !childSessionEffectsAllowed()
        ? 0
        : Math.max(0, countPendingDescendantRuns(params.childSessionKey));
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return "retryable";
      }

      if (childSessionEffectsAllowed()) {
        const directChildren = listSubagentRunsForRequester(params.childSessionKey, {
          requesterRunId: params.childRunId,
        });
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    // Continuation: never re-wake a run that is itself a wake continuation.
    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childSessionEffectsAllowed() &&
      childCompletionFindings?.trim() &&
      subagentRegistryRuntime &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const wake = await wakeSubagentRunAfterDescendants(
        {
          runId: params.childRunId,
          childSessionKey: params.childSessionKey,
          taskLabel: params.label || params.task || "task",
          findings: childCompletionFindings,
          announceId: wakeAnnounceId,
          isChildSessionEffectsAllowed: childSessionEffectsAllowed,
          signal: params.signal,
        },
        subagentAnnounceDeps,
      );
      if (wake === "woke") {
        shouldDeleteChildSession = false;
        return "delivered";
      }
      if (wake === "termination-unconfirmed") {
        // An accepted wake run may still own this child session. Keep the session
        // and leave cleanup unfinished so the registry retries instead of deleting
        // a session out from under a live run.
        shouldDeleteChildSession = false;
        return "retryable";
      }
    }

    let skipAnnounceDelivery = false;
    const fallbackReply = failedTerminalOutcome
      ? undefined
      : normalizeOptionalString(params.fallbackReply);
    const hasVisibleFallback =
      Boolean(fallbackReply) &&
      !(isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));
    const cleanedFallbackReply = hasVisibleFallback
      ? (normalizeSubagentAnnounceReply(fallbackReply ?? "") ?? undefined)
      : undefined;

    if (!childCompletionFindings) {
      if (params.terminalReply?.disposition === "silent") {
        if (
          !managedArtifactReturn &&
          !hasVisibleFallback &&
          (isAnnounceSkip(fallbackReply) || !expectsCompletionMessage)
        ) {
          return "delivered";
        }
        reply = cleanedFallbackReply;
      }
      if (
        childSessionEffectsAllowed() &&
        params.terminalReply?.disposition === "empty" &&
        outcome.status === "timeout"
      ) {
        const timeoutProgress = await readSubagentTimeoutProgress(
          params.childSessionKey,
          params.timeoutMs,
          outcome,
        );
        // Empty remains the authoritative terminal fact. Transcript text is a
        // timeout-only progress hint and must never reclassify silence as output.
        if (timeoutProgress) {
          reply = normalizeSubagentAnnounceReply(timeoutProgress) ?? undefined;
        }
      }
      if (!params.terminalReply) {
        if (childSessionEffectsAllowed() && !reply && allowFailedOutputCapture) {
          reply = await readSubagentOutput(params.childSessionKey, outcome);
        }

        if (childSessionEffectsAllowed() && !reply?.trim() && allowFailedOutputCapture) {
          reply = await readLatestSubagentOutputWithRetry({
            sessionKey: params.childSessionKey,
            maxWaitMs: params.timeoutMs,
            outcome,
          });
        }

        if (!reply?.trim() && hasVisibleFallback) {
          reply = fallbackReply;
        }

        if (outcome.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
          try {
            const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
            const applied = applySubagentWaitOutcome({
              wait: rechecked,
              outcome,
              startedAt: params.startedAt,
              endedAt: params.endedAt,
            });
            outcome = applied.outcome;
            params.startedAt = applied.startedAt;
            params.endedAt = applied.endedAt;
          } catch {
            // Best-effort recheck; keep the existing timeout outcome on failure.
          }
        }

        const replyIsAnnounceSkip = isAnnounceSkip(reply);
        if (replyIsAnnounceSkip || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
          if (hasVisibleFallback && cleanedFallbackReply) {
            reply = cleanedFallbackReply;
          } else {
            warnIfCronAnnounceSkipped({
              reply,
              requesterSessionKey: targetRequesterSessionKey,
              childRunId: params.childRunId,
            });
            const suppressCompletion =
              replyIsAnnounceSkip ||
              isAnnounceSkip(fallbackReply) ||
              !expectsCompletionMessage ||
              hasVisibleFallback;
            if (managedArtifactReturn && suppressCompletion) {
              reply = "(no output)";
            } else if (suppressCompletion) {
              skipAnnounceDelivery = true;
            } else {
              reply = undefined;
            }
          }
        } else if (reply) {
          reply = normalizeSubagentAnnounceReply(reply) ?? cleanedFallbackReply;
          if (!reply) {
            if (managedArtifactReturn) {
              reply = "(no output)";
            } else {
              skipAnnounceDelivery = true;
            }
          }
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    if (!childSessionEffectsAllowed()) {
      childCompletionFindings = undefined;
      reply = params.roundOneReply ?? params.fallbackReply;
      if (
        expectsCompletionMessage &&
        (params.terminalReply?.disposition === "silent" ||
          isSilentReplyText(reply, SILENT_REPLY_TOKEN))
      ) {
        reply = hasVisibleFallback ? cleanedFallbackReply : undefined;
      }
      outcome = params.outcome ?? { status: "unknown" };
    }

    const cfg = subagentAnnounceDeps.getRuntimeConfig();
    const artifactConfig = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
    const announceSessionId = childSessionEffectsAllowed()
      ? childSessionId || "unknown"
      : "unknown";
    const artifactFinalization = childSessionEffectsAllowed()
      ? finalizeDelegateArtifacts({
          producerSessionKey: params.childSessionKey,
          producerSessionId: announceSessionId,
          producerRunId: params.childRunId,
          completionId: announceId,
          finalizationKey: `delegate-artifact-finalization:${announceId}`,
          completionStatus: outcome.status,
          completedAt: params.endedAt ?? Date.now(),
          silent: params.silentAnnounce === true,
          runtimeEnabled: artifactConfig.enabled,
          crossSessionEnabled: artifactConfig.crossSessionTargeting === "enabled",
          resolveSessionId: (sessionKey) => loadSessionEntryByKey(sessionKey)?.sessionId,
        })
      : ({ status: "not-configured" } as const);
    if (artifactFinalization.status === "deferred") {
      return "retryable";
    }
    if (artifactFinalization.status === "failed") {
      outcome = {
        status: "error",
        error: `managed artifact return failed (${artifactFinalization.disposition})`,
      };
    }

    const taskLabel = params.label || params.task || "task";
    let findings = childCompletionFindings || reply || "(no output)";
    if (
      childCompletionFindings?.trim() &&
      findings !== "(no output)" &&
      findings !== childCompletionFindings
    ) {
      findings = `${findings}\n\n[Descendant completions]\n${childCompletionFindings}`;
    }
    const continuationRuntime = await subagentContinuationRuntimeLoader.load();
    const continuation = await continuationRuntime.coordinateSubagentContinuation({
      cfg,
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
      targetRequesterSessionKey,
      targetRequesterOrigin,
      task: params.task ?? "",
      findings,
      skipAnnounceDelivery,
      silentAnnounce: params.silentAnnounce,
      wakeOnReturn: params.wakeOnReturn,
      traceparent: params.traceparent,
      loadEntry: readSessionEntryByKey,
      invalidateSessionEntry,
    });
    findings = continuation.findings;
    if (continuation.skipAnnounceDelivery && !managedArtifactReturn) {
      return "delivered";
    }
    const requesterIsSubagent = requesterIsInternalSession();

    const statsLine = childSessionEffectsAllowed()
      ? await buildCompactAnnounceStatsLine({
          sessionKey: params.childSessionKey,
          startedAt: params.startedAt,
          endedAt: params.endedAt,
        })
      : undefined;
    const finalizedArtifactProjections =
      "projections" in artifactFinalization ? artifactFinalization.projections : undefined;
    let artifactProjections: Map<string, DelegateArtifactRecipientProjectionV1> | undefined;
    if (finalizedArtifactProjections) {
      const deliveryConfig = subagentAnnounceDeps.resolveContinuationRuntimeConfig(
        subagentAnnounceDeps.getRuntimeConfig(),
      );
      artifactProjections = new Map();
      for (const [sessionKey, projection] of finalizedArtifactProjections) {
        const delivery = prepareDelegateArtifactDelivery({
          projection,
          runtimeEnabled: deliveryConfig.enabled,
          crossSessionEnabled: deliveryConfig.crossSessionTargeting === "enabled",
          currentRecipientSessionId: loadSessionEntryByKey(sessionKey)?.sessionId,
        });
        if (delivery.status === "deferred") {
          return "retryable";
        }
        if (delivery.status === "ready") {
          artifactProjections.set(sessionKey, delivery.projection);
        }
      }
    }
    const { internalEvents, triggerMessage, artifactTriggerMessages } =
      buildSubagentAnnounceMessages({
        requesterIsSubagent,
        announceType,
        expectsCompletionMessage,
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        requesterSessionKey: targetRequesterSessionKey,
        taskLabel,
        outcome,
        findings,
        statsLine,
        artifactProjections,
      });
    const returnRoute = await continuationRuntime.routeSubagentContinuationReturn({
      cfg,
      continuationEnabled: continuation.continuationEnabled,
      isContinuationChainDelegate: continuation.isContinuationChainDelegate,
      maxChainLength: subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg).maxChainLength,
      task: params.task ?? "",
      taskLabel,
      triggerMessage,
      ...(artifactFinalization.status !== "not-configured" ? { managedArtifactReturn: true } : {}),
      ...(artifactTriggerMessages ? { triggerMessagesBySessionKey: artifactTriggerMessages } : {}),
      ...(artifactProjections ? { managedArtifactProjections: artifactProjections } : {}),
      announceId,
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
      targetRequesterSessionKey,
      silentAnnounce: params.silentAnnounce,
      wakeOnReturn: params.wakeOnReturn,
      continuationTargetSessionKey: params.continuationTargetSessionKey,
      continuationTargetSessionKeys: params.continuationTargetSessionKeys,
      continuationFanoutMode: params.continuationFanoutMode,
      traceparent: params.traceparent,
      // Resolve the reads lazily: building this object eagerly would touch the
      // read-module namespace on every announce, including flows that never
      // reach the continuation-return router.
      registryRuntime: {
        listAncestorSessionKeys: (sessionKey: string) => listAncestorSessionKeys(sessionKey),
        shouldIgnorePostCompletionAnnounceForSession: (sessionKey: string) =>
          shouldIgnorePostCompletionAnnounceForSession(sessionKey),
      },
    });
    if (returnRoute.deferred) {
      return "retryable";
    }
    if (returnRoute.handled) {
      return "delivered";
    }

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = readRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const candidateCompletionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? !childSessionEffectsAllowed()
          ? targetRequesterOrigin
          : await resolveSubagentCompletionOrigin({
              childSessionKey: params.childSessionKey,
              requesterSessionKey: targetRequesterSessionKey,
              requesterOrigin: directOrigin,
              childRunId: params.childRunId,
              spawnMode: params.spawnMode,
              expectsCompletionMessage,
            })
        : targetRequesterOrigin;
    const completionDirectOrigin = childSessionEffectsAllowed()
      ? candidateCompletionDirectOrigin
      : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    let deliveryResultReported = false;
    const reportDeliveryResult = (delivery: SubagentAnnounceDeliveryResult) => {
      if (deliveryResultReported) {
        return;
      }
      deliveryResultReported = true;
      params.onDeliveryResult?.(delivery);
    };
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceRunId: params.childRunId,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      isSourceSessionEffectsAllowed: completionDeliveryAllowed,
      isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      onDeliveryResult: reportDeliveryResult,
      signal: params.signal,
      continuationTriggerOverride: returnRoute.continuationTriggerOverride,
      ...(returnRoute.traceparent ? { traceparent: returnRoute.traceparent } : {}),
    });
    reportDeliveryResult(delivery);
    announceOutcome = delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable");
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.log(
        `[warn] Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // The spawn label is persisted at run start (agent request `label` →
    // buildAgentSessionPatch), so no post-run label patch is needed here.
    if (
      shouldDeleteChildSession &&
      childSessionEffectsAllowed() &&
      (params.onBeforeDeleteChildSession?.() ?? true)
    ) {
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
        expectedSessionId: childSessionId,
        expectedLifecycleRevision: childSessionLifecycleRevision,
      });
    }
  }
  return announceOutcome;
}

export const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
