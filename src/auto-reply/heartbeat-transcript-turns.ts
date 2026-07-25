import { expectDefined } from "@openclaw/normalization-core";
import { isHeartbeatUserMessage, isRealNonHeartbeatUserMessage } from "./heartbeat-filter.js";

/** Remove complete scheduled heartbeat turns, including visible work, from a shared transcript. */
export function filterHeartbeatTranscriptTurns<T extends { role: string; content?: unknown }>(
  messages: readonly T[],
  heartbeatPrompt?: string,
): T[] {
  const result: T[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = expectDefined(messages[index], "messages entry at index");
    if (!isHeartbeatUserMessage(message, heartbeatPrompt)) {
      result.push(message);
      index++;
      continue;
    }
    // Heartbeats share the main transcript. Everything through the next real
    // user turn belongs to the scheduled run, including tool calls and alerts.
    index++;
    while (index < messages.length) {
      const next = expectDefined(messages[index], "messages entry after heartbeat");
      if (
        isHeartbeatUserMessage(next, heartbeatPrompt) ||
        isRealNonHeartbeatUserMessage(next, heartbeatPrompt)
      ) {
        break;
      }
      index++;
    }
  }
  return result;
}
