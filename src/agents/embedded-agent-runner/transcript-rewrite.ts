import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
/**
 * Rewrites transcript entries in session managers, states, and files.
 */
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../runtime/index.js";
import { getRawSessionAppendMessage } from "../session-raw-append-message.js";
import {
  acquireSessionWriteLock,
  type SessionWriteLockAcquireTimeoutConfig,
  resolveSessionWriteLockOptions,
} from "../session-write-lock.js";
import { SessionManager } from "../sessions/index.js";
import { log } from "./logger.js";
import {
  readTranscriptFileState,
  type TranscriptFileState,
  type TranscriptPersistedEntry,
} from "./transcript-file-state.js";
import {
  persistRuntimeTranscriptStateMutation,
  resolveRuntimeTranscriptReadTarget,
  type RuntimeTranscriptScope,
} from "./transcript-runtime-state.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionBranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];

function isTranscriptEventRecord(event: unknown): event is {
  id?: unknown;
  message?: unknown;
  type?: unknown;
} {
  return typeof event === "object" && event !== null && !Array.isArray(event);
}

async function rewriteSqliteRuntimeTranscript(params: {
  target: Awaited<ReturnType<typeof resolveRuntimeTranscriptReadTarget>>;
  request: TranscriptRewriteRequest;
}): Promise<TranscriptRewriteResult> {
  const marker = parseSqliteSessionFileMarker(params.target.sessionFile);
  if (!marker) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "not a SQLite transcript target",
    };
  }
  const replacementsById = new Map(
    params.request.replacements.map((replacement) => [replacement.entryId, replacement.message]),
  );
  let bytesFreed = 0;
  let rewrittenEntries = 0;
  const events = await loadTranscriptEvents({
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    sessionKey: params.target.sessionKey,
    storePath: marker.storePath,
  });
  const nextEvents = events.map((event) => {
    if (!isTranscriptEventRecord(event)) {
      return event;
    }
    const eventId = typeof event.id === "string" ? event.id : undefined;
    const replacement = eventId ? replacementsById.get(eventId) : undefined;
    if (!replacement || event.type !== "message") {
      return event;
    }
    bytesFreed += Math.max(
      0,
      Buffer.byteLength(JSON.stringify(event.message), "utf8") -
        Buffer.byteLength(JSON.stringify(replacement), "utf8"),
    );
    rewrittenEntries += 1;
    return Object.assign({}, event, {
      message: replacement,
    });
  });
  if (rewrittenEntries === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no matching transcript entries",
    };
  }
  await replaceTranscriptEvents(
    {
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      sessionKey: params.target.sessionKey,
      storePath: marker.storePath,
    },
    nextEvents,
  );
  emitSessionTranscriptUpdate({
    sessionFile: params.target.sessionFile,
    sessionKey: params.target.sessionKey,
    agentId: params.target.agentId,
    target: {
      agentId: params.target.agentId,
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
    },
  });
  return {
    changed: true,
    bytesFreed,
    rewrittenEntries,
  };
}

function estimateMessageBytes(message: AgentMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function findTranscriptRewriteMatches(
  branch: readonly SessionBranchEntry[],
  replacementsById: ReadonlyMap<string, AgentMessage>,
): { matchedIndices: number[]; bytesFreed: number } {
  const matchedIndices: number[] = [];
  let bytesFreed = 0;

  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") {
      continue;
    }
    const replacement = replacementsById.get(entry.id);
    if (!replacement) {
      continue;
    }
    const originalBytes = estimateMessageBytes(entry.message);
    const replacementBytes = estimateMessageBytes(replacement);
    matchedIndices.push(index);
    bytesFreed += Math.max(0, originalBytes - replacementBytes);
  }

  return { matchedIndices, bytesFreed };
}

function remapEntryId(
  entryId: string | null | undefined,
  rewrittenEntryIds: ReadonlyMap<string, string>,
): string | null {
  if (!entryId) {
    return null;
  }
  return rewrittenEntryIds.get(entryId) ?? entryId;
}

function appendBranchEntry(params: {
  sessionManager: SessionManagerLike;
  entry: SessionBranchEntry;
  rewrittenEntryIds: ReadonlyMap<string, string>;
  appendMessage: SessionManagerLike["appendMessage"];
}): string {
  const { sessionManager, entry, rewrittenEntryIds, appendMessage } = params;
  if (entry.type === "message") {
    return appendMessage(entry.message as Parameters<typeof sessionManager.appendMessage>[0]);
  }
  if (entry.type === "compaction") {
    return sessionManager.appendCompaction(
      entry.summary,
      remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
    );
  }
  if (entry.type === "thinking_level_change") {
    return sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
  }
  if (entry.type === "model_change") {
    return sessionManager.appendModelChange(entry.provider, entry.modelId);
  }
  if (entry.type === "custom") {
    return sessionManager.appendCustomEntry(entry.customType, entry.data);
  }
  if (entry.type === "custom_message") {
    return sessionManager.appendCustomMessageEntry(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
    );
  }
  if (entry.type === "session_info") {
    if (entry.name) {
      return sessionManager.appendSessionInfo(entry.name);
    }
    return sessionManager.appendSessionInfo("");
  }
  if (entry.type === "branch_summary") {
    return sessionManager.branchWithSummary(
      remapEntryId(entry.parentId, rewrittenEntryIds),
      entry.summary,
      entry.details,
      entry.fromHook,
    );
  }
  return sessionManager.appendLabelChange(
    remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId,
    entry.label,
  );
}

function appendTranscriptStateBranchEntry(params: {
  state: TranscriptFileState;
  entry: SessionBranchEntry;
  rewrittenEntryIds: ReadonlyMap<string, string>;
}): SessionBranchEntry {
  const { state, entry, rewrittenEntryIds } = params;
  if (entry.type === "message") {
    return state.appendMessage(entry.message);
  }
  if (entry.type === "compaction") {
    return state.appendCompaction(
      entry.summary,
      remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
    );
  }
  if (entry.type === "thinking_level_change") {
    return state.appendThinkingLevelChange(entry.thinkingLevel);
  }
  if (entry.type === "model_change") {
    return state.appendModelChange(entry.provider, entry.modelId);
  }
  if (entry.type === "custom") {
    return state.appendCustomEntry(entry.customType, entry.data);
  }
  if (entry.type === "custom_message") {
    return state.appendCustomMessageEntry(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
    );
  }
  if (entry.type === "session_info") {
    return state.appendSessionInfo(entry.name ?? "");
  }
  if (entry.type === "branch_summary") {
    return state.branchWithSummary(
      remapEntryId(entry.parentId, rewrittenEntryIds),
      entry.summary,
      entry.details,
      entry.fromHook,
    );
  }
  return state.appendLabelChange(
    remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId,
    entry.label,
  );
}

/**
 * Safely rewrites transcript message entries on the active branch by branching
 * from the first rewritten message's parent and re-appending the suffix.
 */
export function rewriteTranscriptEntriesInSessionManager(params: {
  sessionManager: SessionManagerLike;
  replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult {
  const replacementsById = new Map(
    params.replacements
      .filter((replacement) => replacement.entryId.trim().length > 0)
      .map((replacement) => [replacement.entryId, replacement.message]),
  );
  if (replacementsById.size === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no replacements requested",
    };
  }

  const branch = params.sessionManager.getBranch();
  if (branch.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "empty session",
    };
  }

  const { matchedIndices, bytesFreed } = findTranscriptRewriteMatches(branch, replacementsById);

  if (matchedIndices.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no matching message entries",
    };
  }

  const firstMatchedIndex = matchedIndices.at(0);
  const firstMatchedEntry =
    firstMatchedIndex === undefined ? undefined : branch.at(firstMatchedIndex);
  // matchedIndices only contains indices of branch "message" entries.
  if (!firstMatchedEntry || firstMatchedEntry.type !== "message") {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "invalid first rewrite target",
    };
  }

  if (!firstMatchedEntry.parentId) {
    params.sessionManager.resetLeaf();
  } else {
    params.sessionManager.branch(firstMatchedEntry.parentId);
  }

  // Maintenance rewrites should preserve the exact requested history without
  // re-running persistence hooks or size truncation on replayed messages.
  const appendMessage = getRawSessionAppendMessage(params.sessionManager);
  const rewrittenEntryIds = new Map<string, string>();
  for (const entry of branch.slice(firstMatchedIndex)) {
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    const newEntryId =
      replacement === undefined
        ? appendBranchEntry({
            sessionManager: params.sessionManager,
            entry,
            rewrittenEntryIds,
            appendMessage,
          })
        : appendMessage(replacement as Parameters<typeof params.sessionManager.appendMessage>[0]);
    rewrittenEntryIds.set(entry.id, newEntryId);
  }

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
  };
}

export function rewriteTranscriptEntriesInState(params: {
  state: TranscriptFileState;
  replacements: TranscriptRewriteReplacement[];
  allowedRewriteSuffixEntryIds?: string[];
}): TranscriptRewriteResult & { appendedEntries: TranscriptPersistedEntry[] } {
  const replacementsById = new Map(
    params.replacements
      .filter((replacement) => replacement.entryId.trim().length > 0)
      .map((replacement) => [replacement.entryId, replacement.message]),
  );
  if (replacementsById.size === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no replacements requested",
      appendedEntries: [],
    };
  }

  const originalLeafId = params.state.getLeafId();
  const originalAppendParentId = params.state.getAppendParentId();
  const originalAppendMode = params.state.getAppendMode();
  const activeBranch = params.state.getBranch();
  const allEntries = params.state.getEntries();
  let branch = activeBranch;
  let restoreOriginalNavigation = false;
  const replacementIdsOnBranch = (candidate: readonly SessionBranchEntry[]): Set<string> =>
    new Set(
      candidate
        .filter((entry) => entry.type === "message" && replacementsById.has(entry.id))
        .map((entry) => entry.id),
    );
  const activeReplacementIds = replacementIdsOnBranch(activeBranch);
  if (activeReplacementIds.size > 0 && activeReplacementIds.size < replacementsById.size) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "rewrite targets span multiple branches",
      appendedEntries: [],
    };
  }
  const activeBranchHasEveryReplacement = activeReplacementIds.size === replacementsById.size;
  if (!activeBranchHasEveryReplacement && params.allowedRewriteSuffixEntryIds) {
    const allowedIds = new Set(params.allowedRewriteSuffixEntryIds);
    const sideBranch = allEntries
      .toReversed()
      .filter((entry) => allowedIds.has(entry.id))
      .map((entry) => params.state.getBranch(entry.id))
      .find((candidate) => replacementIdsOnBranch(candidate).size === replacementsById.size);
    if (sideBranch) {
      branch = sideBranch;
      restoreOriginalNavigation = true;
    }
  }
  if (
    !activeBranchHasEveryReplacement &&
    !restoreOriginalNavigation &&
    activeReplacementIds.size === 0 &&
    params.replacements.some((replacement) =>
      allEntries.some((entry) => entry.id === replacement.entryId),
    )
  ) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "rewrite targets span multiple branches",
      appendedEntries: [],
    };
  }
  if (branch.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "empty session",
      appendedEntries: [],
    };
  }

  const { matchedIndices, bytesFreed } = findTranscriptRewriteMatches(branch, replacementsById);

  if (matchedIndices.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no matching message entries",
      appendedEntries: [],
    };
  }

  const firstMatchedIndex = matchedIndices.at(0);
  const firstMatchedEntry =
    firstMatchedIndex === undefined ? undefined : branch.at(firstMatchedIndex);
  if (!firstMatchedEntry || firstMatchedEntry.type !== "message") {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "invalid first rewrite target",
      appendedEntries: [],
    };
  }

  if (params.allowedRewriteSuffixEntryIds) {
    const allowedIds = new Set(params.allowedRewriteSuffixEntryIds);
    const hasUnexpectedSuffixEntry = branch
      .slice(firstMatchedIndex)
      .some((entry) => typeof entry.id === "string" && !allowedIds.has(entry.id));
    if (hasUnexpectedSuffixEntry) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "rewrite suffix guard failed",
        appendedEntries: [],
      };
    }
  }

  if (!firstMatchedEntry.parentId) {
    params.state.resetLeaf();
  } else {
    params.state.branch(firstMatchedEntry.parentId);
  }

  const appendedEntries: TranscriptPersistedEntry[] = [];
  const rewrittenEntryIds = new Map<string, string>();
  for (const entry of branch.slice(firstMatchedIndex)) {
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    const newEntry =
      replacement === undefined
        ? appendTranscriptStateBranchEntry({
            state: params.state,
            entry,
            rewrittenEntryIds,
          })
        : params.state.appendMessage(replacement);
    rewrittenEntryIds.set(entry.id, newEntry.id);
    appendedEntries.push(newEntry);
  }
  if (restoreOriginalNavigation) {
    appendedEntries.push(
      params.state.appendLeafControl({
        targetId: originalLeafId,
        appendParentId: originalAppendParentId,
        ...(originalAppendMode ? { appendMode: originalAppendMode } : {}),
      }),
    );
  }

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
    appendedEntries,
  };
}

/**
 * Rewrites message entries for a runtime transcript without using the
 * file-backed path as caller identity.
 */
export async function rewriteTranscriptEntriesInRuntimeTranscript(params: {
  scope: RuntimeTranscriptScope;
  request: TranscriptRewriteRequest;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<TranscriptRewriteResult> {
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    const target = await resolveRuntimeTranscriptReadTarget(params.scope);
    if (parseSqliteSessionFileMarker(target.sessionFile)) {
      return await rewriteSqliteRuntimeTranscript({
        target,
        request: params.request,
      });
    }
    sessionLock = await acquireSessionWriteLock({
      sessionFile: target.sessionFile,
      ...resolveSessionWriteLockOptions(params.config),
    });
    const state = await readTranscriptFileState(target.sessionFile);
    const result = rewriteTranscriptEntriesInState({
      state,
      replacements: params.request.replacements,
      ...(params.request.allowedRewriteSuffixEntryIds
        ? { allowedRewriteSuffixEntryIds: params.request.allowedRewriteSuffixEntryIds }
        : {}),
    });
    if (result.changed) {
      await persistRuntimeTranscriptStateMutation({
        target,
        state,
        appendedEntries: result.appendedEntries,
      });
      emitSessionTranscriptUpdate({
        sessionFile: target.sessionFile,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        target: {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        },
      });
      log.info(
        `[transcript-rewrite] rewrote ${result.rewrittenEntries} entr` +
          `${result.rewrittenEntries === 1 ? "y" : "ies"} ` +
          `bytesFreed=${result.bytesFreed} ` +
          `sessionKey=${target.sessionKey}`,
      );
    }
    return result;
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`[transcript-rewrite] failed: ${reason}`);
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason,
    };
  } finally {
    await sessionLock?.release();
  }
}
