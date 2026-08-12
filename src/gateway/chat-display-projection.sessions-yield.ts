import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { extractAssistantTextForSilentCheck } from "./chat-display-projection.helpers.js";
type YieldSource = { text: string; anchor: Record<string, unknown>; toolCallId?: string };
function yieldSource(value: unknown): YieldSource | undefined {
  const message = readRecord(value);
  const details = readRecord(message?.details);
  const current =
    message?.role === "custom" &&
    message.customType === "openclaw.sessions_yield" &&
    message.display === false &&
    details?.source === "sessions_yield"
      ? readNonBlankString(details.message)
      : undefined;
  if (current && message) {
    return { text: current, anchor: message };
  }
  if (
    message?.role !== "toolResult" ||
    message.toolName !== "sessions_yield" ||
    message.isError === true
  ) {
    return undefined;
  }
  const nested = Array.isArray(message.content)
    ? message.content.map((block) => readRecord(block)?.text)
    : [];
  for (const candidate of [message.details, message.text, message.content, ...nested]) {
    const payload =
      typeof candidate === "string" ? safeParseJsonRecord(candidate) : readRecord(candidate);
    const text = payload?.status === "yielded" ? readNonBlankString(payload.message) : undefined;
    if (text) {
      return { text, anchor: message, toolCallId: readNonBlankString(message.toolCallId) };
    }
  }
  return undefined;
}
function matchesMirror(value: unknown, source: YieldSource): boolean {
  const message = readRecord(value);
  const marker = readRecord(message?.openclawSessionsYieldMirror);
  return (
    message?.role === "assistant" &&
    marker !== undefined &&
    (!source.toolCallId || marker.toolCallId === source.toolCallId) &&
    extractAssistantTextForSilentCheck(message) === source.text
  );
}
function buildMirror(source: YieldSource): Record<string, unknown> {
  const meta = readRecord(source.anchor["__openclaw"]);
  return {
    role: "assistant",
    content: [{ type: "text", text: source.text }],
    openclawSessionsYieldMirror: source.toolCallId ? { toolCallId: source.toolCallId } : {},
    timestamp: source.anchor.timestamp,
    createdAt: source.anchor.createdAt,
    agentId: source.anchor.agentId,
    __openclaw: meta ? { ...meta } : undefined,
  };
}
export function mirrorSessionsYieldVisibleMessages(messages: unknown[]): unknown[] {
  return messages.flatMap((message, index) => {
    let source = yieldSource(message);
    if (!source) {
      return [message];
    }
    const previous = yieldSource(messages[index - 1]);
    const next = yieldSource(messages[index + 1]);
    const current = source.anchor.role === "custom";
    const nextIsCurrent = next?.anchor.role === "custom" && next.text === source.text;
    const legacy = previous?.anchor.role === "toolResult" && previous.text === source.text;
    source = current && legacy ? { ...source, toolCallId: previous.toolCallId } : source;
    return (!current && nextIsCurrent) ||
      matchesMirror(messages[index - 1], source) ||
      matchesMirror(messages[index + 1], source)
      ? [message]
      : [message, buildMirror(source)];
  });
}
