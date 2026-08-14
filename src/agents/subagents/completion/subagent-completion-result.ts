import { selectDeliverableSessionsReply } from "../../tools/sessions-send-tokens.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

/** Selects the canonical operator-visible result from captured completion state. */
export function resolveSubagentCompletionResultText(
  entry: Pick<SubagentRunRecord, "completion" | "execution">,
): string | undefined {
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
