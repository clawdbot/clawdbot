/**
 * Active-requester wake and steering for subagent announcements.
 */
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.shared.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";
import { waitForAnnounceRetryDelay } from "./subagent-announce-delivery-retry.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  getSubagentAnnounceRuntimeConfig,
  getSubagentRequesterSessionActivity,
  isEmbeddedAgentRunActive,
  resolveSubagentRequesterSessionAbandonment,
  loadRequesterSessionEntry,
  queueSubagentAnnounceMessage,
  resolveQueueSettings,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

const SOURCE_OWNER_CHANGED = Symbol("source_owner_changed");

function formatQueueWakeFailureError(
  fallback: string,
  outcome: EmbeddedAgentQueueMessageOutcome,
): string {
  const summary = formatEmbeddedAgentQueueFailureSummary(outcome);
  return summary ? `${fallback}: ${summary}` : fallback;
}

export function resolveRequesterSessionActivity(
  requesterSessionKey: string,
  requesterAgentId?: string,
) {
  const cfg = getSubagentAnnounceRuntimeConfig();
  const resolvedAgentId = tryResolveSubagentRequesterAgentId(
    cfg,
    requesterSessionKey,
    requesterAgentId,
  );
  if (!resolvedAgentId) {
    return { isActive: false };
  }
  const activity = getSubagentRequesterSessionActivity(requesterSessionKey, resolvedAgentId);
  if (activity.sessionId || activity.isActive) {
    return activity;
  }
  const { entry } = loadRequesterSessionEntry(requesterSessionKey, resolvedAgentId);
  const sessionId = entry?.sessionId;
  return {
    sessionId,
    isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
  };
}

// Backoff schedule for re-attempting an active-requester steer while the run is
// compacting. Compaction is transient and usually finishes quickly, so a denser
// schedule is used than for transient delivery errors. Total wait stays well
// within the announce delivery timeout, and the loop also stops on cancellation.
function resolveCompactionSteerRetryDelaysMs() {
  return isFastTestRuntimeEnv()
    ? ([8, 16, 32, 64] as const)
    : ([1_000, 2_000, 4_000, 8_000] as const);
}

// Wake an active requester run through transient compacting and delivery-mode
// outcomes. Unsupported transcript-commit waits are terminal refusals: the loop
// keeps the requested gate intact and lets the caller fall through to the
// canonical requester-agent handoff instead of re-steering on stale context.
export async function resolveActiveWakeWithRetries(
  sessionId: string,
  message: string,
  wakeOptions: EmbeddedAgentQueueMessageOptions,
  signal?: AbortSignal,
  isAttemptAllowed?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome | typeof SOURCE_OWNER_CHANGED> {
  // Bound the whole active wake by the caller's delivery window. Each retry
  // passes only the remaining window into transcript-commit waiting so a
  // near-deadline retry cannot add another full timeout.
  const compactionDeadlineMs =
    typeof wakeOptions.deliveryTimeoutMs === "number" && wakeOptions.deliveryTimeoutMs > 0
      ? Date.now() + wakeOptions.deliveryTimeoutMs
      : undefined;
  let currentOptions = wakeOptions;
  const resolveRetryOptions = (): EmbeddedAgentQueueMessageOptions | undefined => {
    if (compactionDeadlineMs === undefined) {
      return currentOptions;
    }
    const remainingDeliveryTimeoutMs = compactionDeadlineMs - Date.now();
    if (remainingDeliveryTimeoutMs <= 0) {
      return undefined;
    }
    return {
      ...currentOptions,
      deliveryTimeoutMs: remainingDeliveryTimeoutMs,
    };
  };
  const attemptWake = async (options: EmbeddedAgentQueueMessageOptions) => {
    if (isAttemptAllowed?.() === false) {
      return SOURCE_OWNER_CHANGED;
    }
    const result = await queueSubagentAnnounceMessage(sessionId, message, options);
    return isAttemptAllowed?.() === false ? SOURCE_OWNER_CHANGED : result;
  };
  let outcome = await attemptWake(currentOptions);
  const compactionRetryDelaysMs = resolveCompactionSteerRetryDelaysMs();
  let compactionRetryIndex = 0;
  for (;;) {
    if (outcome === SOURCE_OWNER_CHANGED) {
      break;
    }
    if (outcome.queued || signal?.aborted) {
      break;
    }
    if (isAttemptAllowed?.() === false) {
      outcome = SOURCE_OWNER_CHANGED;
      break;
    }
    if (
      outcome.reason === "source_reply_delivery_mode_mismatch" &&
      currentOptions.sourceReplyDeliveryMode !== undefined
    ) {
      // Active requester runs own the final delivery mode. Direct-completion
      // policy must not make an already-running automatic parent unreachable.
      const activeRunOptions = { ...currentOptions };
      delete activeRunOptions.sourceReplyDeliveryMode;
      currentOptions = activeRunOptions;
      outcome = await attemptWake(currentOptions);
      continue;
    }
    if (outcome.reason === "compacting") {
      const remainingDeliveryTimeoutMs =
        compactionDeadlineMs === undefined ? undefined : compactionDeadlineMs - Date.now();
      const canRetry =
        remainingDeliveryTimeoutMs === undefined
          ? compactionRetryIndex < compactionRetryDelaysMs.length
          : remainingDeliveryTimeoutMs > 0;
      if (!canRetry) {
        break;
      }
      // Use the next scheduled backoff delay; once the schedule is exhausted,
      // keep using its last entry until the deadline is reached.
      const scheduledDelayMs =
        compactionRetryDelaysMs[
          Math.min(compactionRetryIndex, compactionRetryDelaysMs.length - 1)
        ] ?? 0;
      // Clamp the wait to the remaining delivery window so the final retry does
      // not sleep past the deadline (which would overrun the delivery timeout).
      // If no time remains, stop retrying and let the fallback handle it.
      const delayMs =
        remainingDeliveryTimeoutMs === undefined
          ? scheduledDelayMs
          : Math.min(scheduledDelayMs, remainingDeliveryTimeoutMs);
      if (delayMs <= 0 && remainingDeliveryTimeoutMs !== undefined) {
        break;
      }
      await waitForAnnounceRetryDelay(delayMs, signal);
      if (signal?.aborted) {
        break;
      }
      compactionRetryIndex += 1;
      const retryOptions = resolveRetryOptions();
      if (!retryOptions) {
        break;
      }
      outcome = await attemptWake(retryOptions);
      continue;
    }
    break;
  }
  return outcome;
}

export async function maybeSteerSubagentAnnounce(params: {
  deliveryTimeoutMs?: number;
  requesterSessionKey: string;
  requesterAgentId?: string;
  steerMessage: string;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  signal?: AbortSignal;
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" | "source_owner_changed" }
> {
  if (params.signal?.aborted) {
    return { status: "none" };
  }
  const cfg = getSubagentAnnounceRuntimeConfig();
  const requesterAgentId = tryResolveSubagentRequesterAgentId(
    cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  if (!requesterAgentId) {
    return { status: "none" };
  }
  const { entry } = loadRequesterSessionEntry(params.requesterSessionKey, requesterAgentId);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey, requesterAgentId);
  const { sessionId, isActive } = resolveRequesterSessionActivity(
    params.requesterSessionKey,
    requesterAgentId,
  );
  if (resolveSubagentRequesterSessionAbandonment(canonicalKey, sessionId)) {
    return { status: "none" };
  }
  if (!sessionId || !isActive) {
    return { status: "none" };
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: sessionDeliveryChannel(entry),
    sessionEntry: entry,
  });

  // Subagent announcements are internal handoffs into an active requester turn.
  // Queue modes such as followup/collect apply to user prompts, not this path.
  const queueOptions: EmbeddedAgentQueueMessageOptions = {
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    steeringMode: "all",
    ...(queueSettings.debounceMs !== undefined ? { debounceMs: queueSettings.debounceMs } : {}),
    waitForTranscriptCommit: true,
    ...(params.createUserTurnTranscriptRecorder
      ? { userTurnTranscriptRecorder: params.createUserTurnTranscriptRecorder(sessionId) }
      : {}),
  };
  const queueOutcome = await resolveActiveWakeWithRetries(
    sessionId,
    params.steerMessage,
    queueOptions,
    params.signal,
    params.isSourceSessionEffectsAllowed,
  );
  if (queueOutcome === SOURCE_OWNER_CHANGED) {
    return { status: "source_owner_changed" };
  }
  if (queueOutcome.queued) {
    return {
      status: "steered",
      deliveredAt: queueOutcome.deliveredAtMs,
      enqueuedAt: queueOutcome.enqueuedAtMs,
    };
  }

  // A stale_run refusal means the requester run is evidence-dead: it will not
  // drain its steer queue, so "dropped" would discard the handoff. Report
  // not-active so dispatch takes the direct fallback instead.
  if (
    queueOutcome.reason === "stale_run" ||
    queueOutcome.reason === "transcript_commit_wait_unsupported"
  ) {
    return { status: "none" };
  }
  const currentActivity = resolveRequesterSessionActivity(
    params.requesterSessionKey,
    requesterAgentId,
  );
  return { status: currentActivity.isActive ? "dropped" : "none" };
}

export function formatActiveWakeFailure(
  fallback: string,
  outcome: EmbeddedAgentQueueMessageOutcome,
): string {
  return formatQueueWakeFailureError(fallback, outcome);
}

export function isSourceOwnerChangedWake(
  outcome: EmbeddedAgentQueueMessageOutcome | typeof SOURCE_OWNER_CHANGED,
): outcome is typeof SOURCE_OWNER_CHANGED {
  return outcome === SOURCE_OWNER_CHANGED;
}
