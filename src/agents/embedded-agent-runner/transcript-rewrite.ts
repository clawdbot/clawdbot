/** Rewrites transcript entries by branching and re-appending the active suffix. */
import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { withSessionPendingInputRelocation } from "../../config/sessions/session-accessor.js";
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { getRawSessionAppendMessage } from "../session-raw-append-message.js";
import { SessionManager } from "../sessions/session-manager.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionBranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];

function stripStalePrefixReplay(message: AgentMessage): AgentMessage {
  return message.role === "assistant" ? stripCompactionReplayCheckpoint(message) : message;
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
    const originalJson = JSON.stringify(entry.message);
    const replacementJson = JSON.stringify(replacement);
    if (originalJson === replacementJson) {
      continue;
    }
    matchedIndices.push(index);
    bytesFreed += Math.max(0, Buffer.byteLength(originalJson) - Buffer.byteLength(replacementJson));
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
    const message = stripStalePrefixReplay(entry.message) as Parameters<
      typeof sessionManager.appendMessage
    >[0];
    return withSessionPendingInputRelocation(entry.id, message, () => appendMessage(message));
  }
  if (entry.type === "compaction") {
    const { __openclaw: identity } = entry;
    return sessionManager.appendCompaction(
      entry.summary,
      remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
      // An unknown historical run must not inherit the rewriting run's identity.
      { runId: identity?.runId, ...identity },
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
  /** Preserve a checkpoint freshly captured on an explicit replacement. */
  preserveReplacementCompactionReplay?: boolean;
}): TranscriptRewriteResult {
  const replacementsById = new Map(
    params.replacements
      .filter((replacement) => replacement.entryId.trim().length > 0)
      .map((replacement) => [
        replacement.entryId,
        params.preserveReplacementCompactionReplay
          ? replacement.message
          : stripStalePrefixReplay(replacement.message),
      ]),
  );
  if (replacementsById.size === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no replacements requested",
    };
  }

  const activeBranch = params.sessionManager.getBranch();
  if (activeBranch.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "empty session",
    };
  }

  const { matchedIndices, bytesFreed } = findTranscriptRewriteMatches(
    activeBranch,
    replacementsById,
  );

  if (matchedIndices.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no changed matching message entries",
    };
  }

  const rewrite = params.sessionManager.prepareTranscriptRewrite();
  const rewriteManager = rewrite.sessionManager;
  const branch = rewriteManager.getBranch();
  if (
    branch.length !== activeBranch.length ||
    branch.some((entry, index) => entry.id !== activeBranch[index]?.id)
  ) {
    throw new Error("Session transcript changed before rewrite preparation");
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
    rewriteManager.resetLeaf();
  } else {
    rewriteManager.branch(firstMatchedEntry.parentId);
  }

  // Maintenance rewrites should preserve the exact requested history without
  // re-running persistence hooks or size truncation on replayed messages.
  const rawAppendMessage = getRawSessionAppendMessage(rewriteManager);
  // Deliberate copies retain ingress keys without adopting their old branch entries.
  const appendMessage: SessionManagerLike["appendMessage"] = (message) =>
    rawAppendMessage(message, { idempotencyLookup: "caller-checked" });
  const rewrittenEntryIds = new Map<string, string>();
  // Every re-appended message follows the rewritten prefix, so its prefix-bound checkpoint is stale.
  for (const entry of branch.slice(firstMatchedIndex)) {
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    const newEntryId =
      replacement === undefined
        ? appendBranchEntry({
            sessionManager: rewriteManager,
            entry,
            rewrittenEntryIds,
            appendMessage,
          })
        : (() => {
            const message = replacement as Parameters<
              typeof params.sessionManager.appendMessage
            >[0];
            return withSessionPendingInputRelocation(entry.id, message, () =>
              appendMessage(message),
            );
          })();
    rewrittenEntryIds.set(entry.id, newEntryId);
  }

  rewrite.commit(rewrittenEntryIds);

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
  };
}
