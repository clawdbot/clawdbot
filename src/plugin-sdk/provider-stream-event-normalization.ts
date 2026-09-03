import { createEmptyTransportUsage } from "@openclaw/ai/transports";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessageEvent, Model, StopReason } from "../llm/types.js";

const STREAM_EVENT_TYPE_RE =
  /^(?:start|(?:text|thinking|toolcall)_(?:start|delta|end)|done|error)$/;
const STOP_REASON_RE = /^(?:stop|length|toolUse|error|aborted)$/;

function materializeMessage(value: unknown, model: Model, stopReason: StopReason): void {
  const message = asOptionalObjectRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    throw new Error("Plain-text tool-call normalization produced an invalid stream event");
  }
  message.api = typeof message.api === "string" ? message.api : model.api;
  message.provider = typeof message.provider === "string" ? message.provider : model.provider;
  message.model = typeof message.model === "string" ? message.model : model.id;
  message.usage ??= createEmptyTransportUsage();
  message.stopReason = STOP_REASON_RE.test(String(message.stopReason))
    ? message.stopReason
    : stopReason;
  message.timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
}

export function assertProviderStreamEvent(
  value: unknown,
  model: Model,
): asserts value is AssistantMessageEvent {
  const event = asOptionalObjectRecord(value);
  if (!event || typeof event.type !== "string" || !STREAM_EVENT_TYPE_RE.test(event.type)) {
    throw new Error("Plain-text tool-call normalization produced an invalid stream event");
  }
  if (event.type === "done") {
    const reason = event.reason === "length" || event.reason === "toolUse" ? event.reason : "stop";
    event.reason = reason;
    materializeMessage(event.message, model, reason);
    return;
  }
  if (event.type === "error") {
    const reason = event.reason === "aborted" ? "aborted" : "error";
    event.reason = reason;
    materializeMessage(event.error, model, reason);
    return;
  }
  if (event.type === "text_delta" && event.partial === undefined) {
    event.contentIndex ??= 0;
    return;
  }
  event.contentIndex ??= 0;
  event.partial ??= { role: "assistant", content: [] };
  materializeMessage(event.partial, model, "stop");
}
