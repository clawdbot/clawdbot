import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { resolveSessionKeyBySessionId as resolveTranscriptSessionKeyBySessionId } from "./session-accessor.sqlite-entry.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import {
  findTranscriptEvent,
  hasSessionTranscriptMessage,
  inspectTranscriptEventsSync,
  loadLatestAssistantText as readLatestTranscriptAssistantText,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  loadTranscriptHeaderSync,
  loadTranscriptTailEventsSync,
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
  readTranscriptEventAtSeqSync,
} from "./session-accessor.sqlite-read.js";
import { rewriteTranscriptMessageAtAnchor } from "./session-accessor.sqlite-transcript-message-rewrite.js";
import {
  appendTranscriptEvent,
  appendTranscriptEventSync,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  persistCompactionBoundaryWithSessionEntrySync,
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
  replaceSessionWithBranchedTranscript,
  rewriteTranscriptEventRowsExact,
  trimTranscriptForManualCompact,
  withTranscriptWriteLock,
  withTranscriptWriteTransaction,
} from "./session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptManualTrimResult,
  SessionTranscriptManualTrimPreflightResult,
} from "./session-accessor.types.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

// Persisted transcripts have one SQLite owner. Re-export its canonical operations directly.
export {
  appendTranscriptEvent,
  appendTranscriptEventSync,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  findTranscriptEvent,
  hasSessionTranscriptMessage,
  inspectTranscriptEventsSync,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  loadTranscriptHeaderSync,
  loadTranscriptTailEventsSync,
  persistCompactionBoundaryWithSessionEntrySync,
  publishTranscriptUpdate,
  readLatestTranscriptAssistantText,
  readTranscriptEventAtSeqSync,
  readTranscriptRawDelta,
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
  replaceSessionWithBranchedTranscript,
  rewriteTranscriptEventRowsExact,
  rewriteTranscriptMessageAtAnchor,
  resolveTranscriptSessionKeyBySessionId,
  withTranscriptWriteLock,
  withTranscriptWriteTransaction,
};
export { emitSessionTranscriptUpdate as emitTranscriptUpdate } from "../../sessions/transcript-events.js";

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function preflightSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimPreflightResult> {
  const eventCount = readTranscriptStatsSync(scope).eventCount;
  if (eventCount === 0) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  return eventCount > maxLines ? { compacted: true } : { compacted: false, kept: eventCount };
}

export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimResult> {
  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const maxTailLines = Math.max(0, maxLines - 1);
  let declined: SessionTranscriptManualTrimResult = { compacted: false, reason: "no transcript" };
  const trimmed = await trimTranscriptForManualCompact(
    scope,
    (lines) => {
      if (lines.length === 0) {
        declined = { compacted: false, reason: "no transcript" };
        return null;
      }
      if (lines.length <= maxLines) {
        declined = { compacted: false, kept: lines.length };
        return null;
      }
      const tailLines = lines.slice(1);
      const retainedLines = normalizeManualCompactTranscriptLines(
        lines[0],
        maxTailLines > 0 ? tailLines.slice(-maxTailLines) : [],
      );
      if (!retainedLines) {
        declined = { compacted: false, kept: 0 };
        return null;
      }
      return retainedLines;
    },
    params.nowMs === undefined ? {} : { nowMs: params.nowMs },
  );
  if (!trimmed.trimmed) {
    return declined;
  }

  return { compacted: true, kept: trimmed.kept };
}

function parseManualCompactTranscriptRecord(line: string): Record<string, unknown> | null {
  return safeParseJsonRecord(line) ?? null;
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = parseManualCompactTranscriptRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(parseManualCompactTranscriptRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if ((next.type === "compaction" || next.type === "reset") && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}
