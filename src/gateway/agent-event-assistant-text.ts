// Gateway assistant-event text extractor.
// Normalizes provider stream event shapes into a display text delta.
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

export function isReplaceableAssistantStreamEvent(evt: AgentEventPayload): boolean {
  return evt.data.replaceable === true;
}

export function resolveAssistantStreamSnapshotText(evt: AgentEventPayload): string {
  const text = evt.data.text;
  if (typeof text === "string") {
    return text;
  }
  return resolveAssistantStreamDeltaText(evt);
}
