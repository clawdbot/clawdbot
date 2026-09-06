import type { AgentMessage } from "@openclaw/agent-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

// Native replay retains the exact submitted prompt. Model-context consumers already
// have its visible content; copying this storage-only payload duplicates the prompt.
export const MODEL_CONTEXT_PRIVATE_METADATA_KEYS = ["upstreamUserText"] as const;

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export function stripToolResultDetails(messages: unknown[]): unknown[];
export function stripToolResultDetails(messages: unknown[]): unknown[] {
  let touched = false;
  const out = messages.map((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "toolResult" || !("details" in record)) {
      return message;
    }
    const sanitized = { ...record };
    delete sanitized.details;
    touched = true;
    return sanitized;
  });
  return touched ? out : messages;
}

/** A transient view; evidence and persistence readers must retain the original messages. */
export function projectModelContextMessages(messages: unknown[]): unknown[] {
  const output: unknown[] = [];
  for (const message of stripToolResultDetails(messages)) {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (!metadata || !MODEL_CONTEXT_PRIVATE_METADATA_KEYS.some((key) => key in metadata)) {
      output.push(message);
      continue;
    }
    const projected = { ...metadata };
    for (const key of MODEL_CONTEXT_PRIVATE_METADATA_KEYS) {
      delete projected[key];
    }
    output.push({ ...record, __openclaw: projected });
  }
  return output;
}
