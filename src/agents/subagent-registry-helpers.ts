/**
 * Subagent registry persistence and recovery helpers.
 *
 * Handles frozen result caps, orphan detection, timing persistence, and announce retry logging.
 */
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES } from "../config/agent-limits.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import { getDeliveryAttemptCount, getDeliveryLastError } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldUpdateRunOutcome } from "./subagent-registry-completion.js";
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
export const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;
export const MAX_ANNOUNCE_RETRY_COUNT = 3;
export const ANNOUNCE_EXPIRY_MS = 5 * 60_000;
export const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000;

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
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  // retryCount is "attempts already made", so retry #1 waits 1s, then 2s, 4s...
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}

function formatAnnounceGiveUpLogField(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    normalized.length > 2_000 ? `${truncateUtf16Safe(normalized, 2_000)}…` : normalized,
  );
}

/** Logs a sanitized final give-up line for failed subagent announce delivery. */
export function logAnnounceGiveUp(entry: SubagentRunRecord, reason: "retry-limit" | "expiry") {
  const retryCount = getDeliveryAttemptCount(entry);
  const endedAgoMs =
    typeof entry.endedAt === "number" ? Math.max(0, Date.now() - entry.endedAt) : undefined;
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
  options?: { isCurrentGeneration?: () => boolean },
) {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return;
  }

  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const startedAt = getSubagentSessionStartedAt(entry);
  const endedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : undefined;
  const runtimeMs =
    endedAt !== undefined
      ? getSubagentSessionRuntimeMs(entry, endedAt)
      : getSubagentSessionRuntimeMs(entry);
  const status = resolveSubagentSessionStatus(entry);

  await patchSessionEntry(
    { storePath, sessionKey: childSessionKey },
    (sessionEntry) => {
      // Recheck under the session-store write lock. A completion may have
      // waited behind a steer/restart that transferred this session's ownership.
      if (options?.isCurrentGeneration && !options.isCurrentGeneration()) {
        return null;
      }
      if (status === "killed") {
        const existingCompletion = resolveCompletionFromSessionEntry(sessionEntry, Date.now(), {
          notBeforeMs: entry.startedAt ?? entry.createdAt,
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
    { replaceEntry: true },
  );
}

// Attachment cleanup must stay within the recorded root even if paths were
// symlinks. Compare real paths before removing anything recursively.
function isResolvedChildPath(params: { childPath: string; rootPath: string }) {
  const rootWithSep = params.rootPath.endsWith(path.sep)
    ? params.rootPath
    : `${params.rootPath}${path.sep}`;
  return params.childPath.startsWith(rootWithSep);
}

/** Best-effort async removal for a subagent attachment directory. */
export async function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<boolean> {
  if (!entry.attachmentsDir || !entry.attachmentsRootDir) {
    return true;
  }

  const resolveReal = async (targetPath: string): Promise<string | null> => {
    try {
      return await fs.realpath(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  };

  try {
    const [rootReal, dirReal] = await Promise.all([
      resolveReal(entry.attachmentsRootDir),
      resolveReal(entry.attachmentsDir),
    ]);
    if (!dirReal) {
      return true;
    }

    const rootBase = rootReal ?? path.resolve(entry.attachmentsRootDir);
    const dirBase = dirReal;
    if (!isResolvedChildPath({ childPath: dirBase, rootPath: rootBase })) {
      return false;
    }
    await fs.rm(dirBase, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function safeRemoveAttachmentsDirSync(entry: SubagentRunRecord): void {
  if (!entry.attachmentsDir || !entry.attachmentsRootDir) {
    return;
  }

  const resolveReal = (targetPath: string): string | null => {
    try {
      return fsSync.realpathSync.native(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  };

  try {
    const rootReal = resolveReal(entry.attachmentsRootDir);
    const dirReal = resolveReal(entry.attachmentsDir);
    if (!dirReal) {
      return;
    }

    const rootBase = rootReal ?? path.resolve(entry.attachmentsRootDir);
    if (!isResolvedChildPath({ childPath: dirReal, rootPath: rootBase })) {
      return;
    }
    fsSync.rmSync(dirReal, { recursive: true, force: true });
  } catch {
    // best effort
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
  const now = Date.now();
  let changed = false;
  if (typeof params.entry.endedAt !== "number") {
    params.entry.endedAt = now;
    changed = true;
  }
  const orphanOutcome = withSubagentOutcomeTiming(
    {
      status: "error",
      error: `orphaned subagent run (${params.reason})`,
    },
    {
      startedAt: params.entry.startedAt,
      endedAt: params.entry.endedAt,
    },
  );
  if (shouldUpdateRunOutcome(params.entry.outcome, orphanOutcome)) {
    params.entry.outcome = orphanOutcome;
    changed = true;
  }
  if (params.entry.endedReason !== SUBAGENT_ENDED_REASON_ERROR) {
    params.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    changed = true;
  }
  if (params.entry.cleanupHandled !== true) {
    params.entry.cleanupHandled = true;
    changed = true;
  }
  if (typeof params.entry.cleanupCompletedAt !== "number") {
    params.entry.cleanupCompletedAt = now;
    changed = true;
  }
  const shouldDeleteAttachments =
    params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    safeRemoveAttachmentsDirSync(params.entry);
  }
  const removed = params.runs.delete(params.runId);
  params.resumedRuns.delete(params.runId);
  if (!removed && !changed) {
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
    if (entry.killReconciliation || entry.terminalOwner === "interrupted-recovery") {
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

/** Resolves the archive deadline for one newly registered run. */
export function resolveSubagentArchiveAtMs(params: {
  cfg?: OpenClawConfig;
  now: number;
  spawnMode: "run" | "session";
  cleanup: "keep" | "delete";
  collect?: boolean;
}): number | undefined {
  if (params.spawnMode === "session" || params.collect || params.cleanup === "keep") {
    return undefined;
  }
  const archiveAfterMs = resolveArchiveAfterMs(params.cfg);
  return archiveAfterMs ? params.now + archiveAfterMs : undefined;
}

/** Backfills the retention deadline added after collector groups first shipped. */
export function backfillCollectorArchiveAtMs(
  entry: SubagentRunRecord,
  cfg?: OpenClawConfig,
): boolean {
  if (!entry.collect) {
    return false;
  }
  const endedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : undefined;
  const capturedAt =
    endedAt === undefined && !entry.collectorCompletion
      ? undefined
      : typeof entry.completion?.capturedAt === "number" &&
          Number.isFinite(entry.completion.capturedAt)
        ? entry.completion.capturedAt
        : endedAt;
  const archiveAfterMs = entry.spawnMode === "session" ? undefined : resolveArchiveAfterMs(cfg);
  const expectedArchiveAt =
    capturedAt !== undefined && archiveAfterMs !== undefined
      ? capturedAt + archiveAfterMs
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
