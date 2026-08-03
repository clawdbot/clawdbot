/**
 * Repairs persisted signed-thinking replay state after provider-confirmed rejection.
 */
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../runtime/index.js";
import { log } from "./logger.js";
import { stripThinkingBlocksFromMessage } from "./thinking.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

type RewritableSessionManager = Parameters<
  typeof rewriteTranscriptEntriesInSessionManager
>[0]["sessionManager"];

export function repairRejectedThinkingReplayInSessionManager(params: {
  sessionManager: RewritableSessionManager;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): { repaired: boolean; repairedCount: number; reason?: string } {
  const replacements: Array<{ entryId: string; message: AgentMessage }> = [];
  for (const entry of params.sessionManager.getBranch()) {
    if (entry.type !== "message") {
      continue;
    }
    const replacement = stripThinkingBlocksFromMessage(entry.message);
    if (replacement === entry.message) {
      continue;
    }
    replacements.push({ entryId: entry.id, message: replacement });
  }

  if (replacements.length === 0) {
    return {
      repaired: false,
      repairedCount: 0,
      reason: "no thinking blocks on active branch",
    };
  }

  const rewriteResult = rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements,
  });
  if (!rewriteResult.changed) {
    return {
      repaired: false,
      repairedCount: 0,
      reason: rewriteResult.reason,
    };
  }

  if (params.sessionFile) {
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  }
  log.warn(
    `[session-recovery] stripped thinking blocks after provider rejected replay: ` +
      `repaired=${rewriteResult.rewrittenEntries} sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );

  return {
    repaired: true,
    repairedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}
