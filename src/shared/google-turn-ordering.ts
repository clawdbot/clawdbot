// Google turn ordering helpers keep Google model conversations in supported order.
import type { AgentMessage } from "../agents/runtime/index.js";

const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

/** Add a synthetic user bootstrap when Google-style providers receive assistant-first turns. */
export function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[] {
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  const role = first?.role;
  const content = first?.content;
  if (
    role === "user" &&
    typeof content === "string" &&
    content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (role !== "assistant") {
    return messages;
  }

  // Google chat APIs reject assistant-first transcripts. The bootstrap marker
  // makes the mutation idempotent while preserving the original assistant turn.
  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;

  return [bootstrap, ...messages];
}
