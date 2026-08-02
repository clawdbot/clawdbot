import { isChannelProgressDraftWorkToolName } from "./streaming.js";

/** Tracks per-turn activity for compact progress receipts. */
export function createChannelProgressReceiptTracker(params?: { now?: () => number }) {
  const now = params?.now ?? Date.now;
  let startedAt = now();
  let reasoningSteps = 0;
  let toolCalls = 0;
  let commentaryNotes = 0;
  let reasoningOpen = false;
  const seenCommentaryIds = new Set<string>();
  let lastCommentaryText = "";

  const closeReasoning = () => {
    if (!reasoningOpen) {
      return;
    }
    reasoningOpen = false;
    reasoningSteps += 1;
  };

  const reset = () => {
    startedAt = now();
    reasoningSteps = 0;
    toolCalls = 0;
    commentaryNotes = 0;
    reasoningOpen = false;
    seenCommentaryIds.clear();
    lastCommentaryText = "";
  };

  return {
    noteReasoning() {
      reasoningOpen = true;
    },
    closeReasoning,
    noteToolCall(toolName?: string) {
      closeReasoning();
      if (isChannelProgressDraftWorkToolName(toolName)) {
        toolCalls += 1;
      }
    },
    noteCommentary(itemId?: string, text?: string) {
      const trimmed = text?.trim();
      if (!trimmed) {
        return;
      }
      if (itemId) {
        if (!seenCommentaryIds.has(itemId)) {
          seenCommentaryIds.add(itemId);
          commentaryNotes += 1;
        }
        return;
      }
      if (trimmed !== lastCommentaryText) {
        lastCommentaryText = trimmed;
        commentaryNotes += 1;
      }
    },
    reset,
    buildSummaryLine() {
      closeReasoning();
      const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
      return [
        ...(reasoningSteps > 0
          ? [`🧠 ${reasoningSteps} thought${reasoningSteps === 1 ? "" : "s"}`]
          : []),
        ...(commentaryNotes > 0
          ? [`💬 ${commentaryNotes} note${commentaryNotes === 1 ? "" : "s"}`]
          : []),
        ...(toolCalls > 0 ? [`🛠️ ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : []),
        `⏱️ ${seconds}s`,
      ].join(" · ");
    },
  };
}
