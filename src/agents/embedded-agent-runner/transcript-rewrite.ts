import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
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
import { SessionManager } from "../sessions/index.js";
import { log } from "./logger.js";
import {
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
  const replacementsById = new Map(
    params.request.replacements.map((replacement) => [replacement.entryId, replacement.message]),
  );
  let bytesFreed = 0;
  let rewrittenEntries = 0;
  const events = await loadTranscriptEvents({
    agentId: params.target.agentId,
    sessionId: params.target.sessionId,
    sessionKey: params.target.sessionKey,
    storePath: params.target.storePath,
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
      agentId: params.target.agentId,
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
      storePath: params.target.storePath,
    },
    nextEvents,
  );
  emitSessionTranscriptUpdate({
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
  if (entry.type === "reset") {
    return sessionManager.appendResetBoundary(
      entry.reason,
      entry.firstKeptEntryId
        ? (remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId)
        : undefined,
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

/**
 * Rewrites message entries for a runtime transcript without using the
 * file-backed path as caller identity.
 */
export async function rewriteTranscriptEntriesInRuntimeTranscript(params: {
  scope: RuntimeTranscriptScope;
  request: TranscriptRewriteRequest;
}): Promise<TranscriptRewriteResult> {
  try {
    const target = await resolveRuntimeTranscriptReadTarget(params.scope);
    return await rewriteSqliteRuntimeTranscript({
      target,
      request: params.request,
    });
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`[transcript-rewrite] failed: ${reason}`);
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason,
    };
  }
}
