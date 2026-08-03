import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { selectDeliverableSessionsReply } from "./tools/sessions-send-tokens.js";

/** Selects the canonical operator-visible result from captured completion state. */
export function resolveSubagentCompletionResultText(
  entry: Pick<SubagentRunRecord, "completion" | "execution">,
): string | undefined {
  const primary = entry.completion?.resultText;
  const fallback = entry.completion?.fallbackResultText;
  if (entry.execution.outcome?.status === "ok") {
    return selectDeliverableSessionsReply(primary, fallback);
  }
  return (primary ?? fallback)?.trim() || undefined;
}
