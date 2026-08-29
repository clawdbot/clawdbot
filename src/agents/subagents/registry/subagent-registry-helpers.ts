/**
 * Subagent registry persistence and recovery helpers.
 *
 * Handles frozen result caps, orphan detection, timing persistence, and announce retry logging.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES } from "../../../config/agent-limits.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { computeBackoff } from "../../../infra/backoff.js";
import { defaultRuntime } from "../../../runtime.js";
import { truncateUtf8Prefix } from "../../../utils/utf8-truncate.js";
import {
  cleanupMaterializedSubagentAttachments,
  cleanupMaterializedSubagentAttachmentsSync,
} from "../subagent-attachment-cleanup.js";
import {
  getDeliveryAttemptCount,
  getDeliveryLastError,
  hasRetainedRequiredCompletionDelivery,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";
import {
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

export const PROVISIONAL_KILL_RECONCILIATION_MS = 5 * 60_000;
export const MIN_ANNOUNCE_RETRY_DELAY_MS = 15_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 5 * 60_000;
const ANNOUNCE_RETRY_JITTER = 0.2;
export const ANNOUNCE_EXPIRY_MS = 5 * 60_000;
export const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000;

const ANNOUNCE_RETRY_BACKOFF = {
  initialMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
  maxMs: MAX_ANNOUNCE_RETRY_DELAY_MS,
  factor: 2,
  jitter: ANNOUNCE_RETRY_JITTER,
};

const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;

/** Caps frozen completion text stored for later announce/recovery delivery. */
export function capFrozenResultText(resultText: string): string {
  const trimmed = resultText.trim();
  if (!trimmed) {
    return "";
  }
  const totalBytes = Buffer.byteLength(trimmed, "utf8");
  if (totalBytes <= FROZEN_RESULT_TEXT_MAX_BYTES) {
    return trimmed;
  }
  const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(FROZEN_RESULT_TEXT_MAX_BYTES / 1024)}KB (${Math.round(totalBytes / 1024)}KB)]`;
  const maxPayloadBytes = Math.max(
    0,
    FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
  );
  const payload = truncateUtf8Prefix(trimmed, maxPayloadBytes);
  return `${payload}${notice}`;
}

/** Computes bounded exponential backoff for subagent announce retries. */
export function resolveAnnounceRetryDelayMs(retryCount: number) {
  return computeBackoff(ANNOUNCE_RETRY_BACKOFF, Math.max(1, retryCount));
}

function formatAnnounceGiveUpLogField(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    normalized.length > 2_000 ? `${truncateUtf16Safe(normalized, 2_000)}…` : normalized,
  );
}

/** Logs a sanitized final give-up line for failed subagent announce delivery. */
export function logAnnounceGiveUp(
  entry: SubagentRunRecord,
  reason: "expiry" | "permanent_failure",
) {
  const retryCount = getDeliveryAttemptCount(entry);
  const endedAt = entry.execution.endedAt;
  const endedAgoMs = typeof endedAt === "number" ? Math.max(0, Date.now() - endedAt) : undefined;
  const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1000)}s` : "n/a";
  const lastDeliveryError = getDeliveryLastError(entry);
  const deliveryError = lastDeliveryError
    ? ` deliveryError=${formatAnnounceGiveUpLogField(lastDeliveryError)}`
    : "";
  defaultRuntime.log(
    `[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}${deliveryError}`,
  );
}

/** Persists child session timing/status derived from the subagent registry row. */
export async function persistSubagentSessionTiming(
  entry: SubagentRunRecord,
  options?: {
    isCurrentGeneration?: () => boolean;
    assertCommitAllowed?: () => void;
  },
) {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return;
  }

  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const startedAt = getSubagentSessionStartedAt(entry);
  const endedAt =
    typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt)
      ? entry.execution.endedAt
      : undefined;
  const runtimeMs =
    endedAt !== undefined
      ? getSubagentSessionRuntimeMs(entry, endedAt)
      : getSubagentSessionRuntimeMs(entry);
  const status = resolveSubagentSessionStatus(entry);

  await patchSessionEntryCore(
    { storePath, sessionKey: childSessionKey },
    (sessionEntry) => {
      // Recheck under the session-store write lock. A completion may have
      // waited behind a steer/restart that transferred this session's ownership.
      if (options?.isCurrentGeneration && !options.isCurrentGeneration()) {
        return null;
      }
      if (status === "killed") {
        const existingCompletion = resolveCompletionFromSessionEntry(sessionEntry, Date.now(), {
          notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
        });
        if (existingCompletion && existingCompletion.reason !== SUBAGENT_ENDED_REASON_KILLED) {
          // A provider result already reached durable session state. The kill
          // marker is provisional and must not erase restart reconciliation evidence
          // or leave the session looking aborted after that completion won.
          if (sessionEntry.abortedLastRun !== true) {
            return null;
          }
          const completedEntry = { ...sessionEntry };
          delete completedEntry.abortedLastRun;
          return completedEntry;
        }
      }
      const next = { ...sessionEntry };

      if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
        next.startedAt = startedAt;
      } else {
        delete next.startedAt;
      }

      if (typeof endedAt === "number" && Number.isFinite(endedAt)) {
        next.endedAt = endedAt;
      } else {
        delete next.endedAt;
      }

      if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) {
        next.runtimeMs = runtimeMs;
      } else {
        delete next.runtimeMs;
      }

      if (status) {
        next.status = status;
      } else {
        delete next.status;
      }
      if (status && status !== "killed") {
        delete next.abortedLastRun;
      }
      return next;
    },
    {
      assertCommitAllowed: options?.assertCommitAllowed,
      replaceEntry: true,
    },
  );
}

/** Best-effort async removal for a subagent attachment directory. */
export async function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<boolean> {
  if (!entry.attachmentId) {
    // Shipped legacy rows contain workspace-controlled absolute paths. They are
    // intentionally ignored; absence of a new owned identity is not retryable.
    return true;
  }

  try {
    await cleanupMaterializedSubagentAttachments({
      childSessionKey: entry.childSessionKey,
      attachmentId: entry.attachmentId,
    });
    return true;
  } catch {
    return false;
  }
}

/** Marks an orphaned registry run finished, cleans attachments, and removes it. */
export function reconcileOrphanedRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  reason: SubagentRunOrphanReason;
  source: "restore" | "resume";
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
}) {
  if (hasRetainedRequiredCompletionDelivery(params.entry)) {
    return false;
  }
  const shouldDeleteAttachments =
    params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    if (params.entry.attachmentId) {
      try {
        cleanupMaterializedSubagentAttachmentsSync({
          childSessionKey: params.entry.childSessionKey,
          attachmentId: params.entry.attachmentId,
        });
      } catch {
        // Best effort during synchronous restore reconciliation.
      }
    }
  }
  const removed = params.runs.delete(params.runId);
  params.resumedRuns.delete(params.runId);
  if (!removed) {
    return false;
  }
  defaultRuntime.log(
    `[warn] Subagent orphan run pruned source=${params.source} run=${params.runId} child=${params.entry.childSessionKey} reason=${params.reason}`,
  );
  return true;
}

/** Reconciles orphaned runs found when restoring persisted subagent registry state. */
export function reconcileOrphanedRestoredRuns(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
}) {
  const now = Date.now();
  let changed = false;
  for (const [runId, entry] of params.runs.entries()) {
    if (entry.collect && entry.collectorCompletion) {
      // Waitable collector tombstones intentionally outlive delete-mode sessions.
      continue;
    }
    if (entry.requesterSettleWake) {
      // Requester-settle outbox rows can intentionally outlive delete-mode
      // child sessions. Restore replays the obligation before retiring them.
      continue;
    }
    if (
      entry.killReconciliation ||
      entry.killIntent ||
      entry.execution.restartRecovery ||
      entry.terminalOwner === "interrupted-recovery"
    ) {
      // Provider completion or interrupted recovery still owns these rows.
      // Their bounded reconciliation runs even when the session vanished.
      continue;
    }
    const orphanReason = resolveSubagentRunOrphanReason({
      entry,
      includeStaleUnended: true,
      now,
    });
    if (!orphanReason) {
      continue;
    }
    if (
      reconcileOrphanedRun({
        runId,
        entry,
        reason: orphanReason,
        source: "restore",
        runs: params.runs,
        resumedRuns: params.resumedRuns,
      })
    ) {
      changed = true;
    }
  }
  return changed;
}

/** Resolves the completed subagent archive delay from config. */
function resolveArchiveAfterMs(cfg?: OpenClawConfig) {
  const config = cfg ?? getRuntimeConfig();
  const minutes =
    config.agents?.defaults?.subagents?.archiveAfterMinutes ??
    DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 0) {
    return undefined;
  }
  if (minutes === 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

/** Arms retention only after the run or its waitable collector result has completed. */
export function updateSubagentArchiveAtMs(entry: SubagentRunRecord, cfg?: OpenClawConfig): boolean {
  const endedAt =
    typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt)
      ? entry.execution.endedAt
      : undefined;
  const completedAt = entry.collect
    ? endedAt === undefined && !entry.collectorCompletion
      ? undefined
      : typeof entry.completion?.capturedAt === "number" &&
          Number.isFinite(entry.completion.capturedAt)
        ? entry.completion.capturedAt
        : endedAt
    : entry.cleanup === "delete" && entry.pauseReason !== "sessions_yield"
      ? endedAt
      : undefined;
  const archiveAfterMs =
    entry.spawnMode === "session" || completedAt === undefined
      ? undefined
      : resolveArchiveAfterMs(cfg);
  const expectedArchiveAt =
    completedAt !== undefined && archiveAfterMs !== undefined
      ? completedAt + archiveAfterMs
      : undefined;
  if (entry.archiveAtMs === expectedArchiveAt) {
    return false;
  }
  if (expectedArchiveAt === undefined) {
    delete entry.archiveAtMs;
  } else {
    entry.archiveAtMs = expectedArchiveAt;
  }
  return true;
}
