import type { AgentMessage } from "../../runtime/index.js";

/** Gives hooks an isolated message snapshot they cannot mutate in-session. */
export function cloneHookMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => structuredClone(message));
}
