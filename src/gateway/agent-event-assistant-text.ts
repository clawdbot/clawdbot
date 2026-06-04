import type { AgentEventPayload } from "../infra/agent-events.js";

// Agent stream events may carry assistant text as either incremental delta or
// full text, depending on provider/runtime. Gateway display paths normalize the
// two shapes here before broadcasting.
/** Extracts the assistant-visible text delta from an agent event payload. */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
