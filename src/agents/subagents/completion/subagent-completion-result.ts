import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { selectDeliverableSessionsReply } from "../../tools/sessions-send-tokens.js";

/** Selects the canonical operator-visible result from captured completion state. */
export function resolveSubagentCompletionResultText(entry: {
  completion?: {
    required?: boolean;
    resultText?: string | null;
    fallbackResultText?: string | null;
    terminalReply?: AgentRunTerminalReplySnapshot;
  };
  execution: {
    status?: "queued" | "running" | "interrupted" | "terminal";
    outcome?: { status: "ok" | "error" | "timeout" | "unknown" };
  };
}): string | undefined {
  const terminalReply = entry.completion?.terminalReply;
  // Producer-owned terminal evidence outranks retained transcript fallback text.
  // Otherwise an intentionally silent/empty run can leak an older visible reply.
  if (terminalReply) {
    return terminalReply.disposition === "visible" ? terminalReply.text : undefined;
  }
  const primary = entry.completion?.resultText;
  const fallback = entry.completion?.fallbackResultText;
  if (entry.execution.outcome?.status === "ok") {
    return selectDeliverableSessionsReply(primary, fallback);
  }
  return (primary ?? fallback)?.trim() || undefined;
}
