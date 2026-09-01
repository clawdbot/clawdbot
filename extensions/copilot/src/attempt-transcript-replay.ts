import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
export type AttemptTranscriptMessage =
  | NonNullable<TranscriptRecorder["message"]>
  | Extract<AgentMessage, { role: "assistant" | "toolResult" }>;

function readAssistantToolCallIds(message: AttemptTranscriptMessage): string[] {
  return message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
    : [];
}

export function isCompatibleSingletonRewrite(
  original: AttemptTranscriptMessage,
  prepared: AttemptTranscriptMessage,
): boolean {
  // Hooks may redact content, but role and tool topology are journal-owned;
  // accepting either rewrite would make the canonical replay structurally false.
  return (
    original.role === prepared.role &&
    (original.role !== "assistant" ||
      JSON.stringify(readAssistantToolCallIds(original)) ===
        JSON.stringify(readAssistantToolCallIds(prepared)))
  );
}

export function projectReplayPayload(message: AttemptTranscriptMessage): unknown {
  switch (message.role) {
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: message.role,
        content: message.content,
        api: message.api,
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
      };
    case "toolResult":
      return {
        role: message.role,
        content: message.content,
        isError: message.isError,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      };
  }
  return undefined;
}

export function isCompleteToolGroup(
  messages: AttemptTranscriptMessage[],
  order: string[],
): boolean {
  const [assistant, ...results] = messages;
  return (
    assistant?.role === "assistant" &&
    JSON.stringify(readAssistantToolCallIds(assistant)) === JSON.stringify(order) &&
    results.length === order.length &&
    results.every(
      (message, index) => message.role === "toolResult" && message.toolCallId === order[index],
    )
  );
}
