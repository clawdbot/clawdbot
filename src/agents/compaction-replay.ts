import { stripStaleAssistantUsageBeforeLatestCompaction } from "./compaction-usage.js";
import type { AgentMessage } from "./runtime/index.js";
import { stripStaleThinkingSignaturesForCompactionReplay } from "./thinking-signatures.js";

/** Keep every transcript rebuild safe for the next provider request. */
export function sanitizeCompactionReplayMessages(messages: AgentMessage[]): AgentMessage[] {
  return stripStaleThinkingSignaturesForCompactionReplay(
    stripStaleAssistantUsageBeforeLatestCompaction(messages),
  );
}
