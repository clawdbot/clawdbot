import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../llm/types.js";

export const ASSISTANT_DISPLAY_CONTENT_FIELD = "openclawDisplayContent";

type AssistantModelContentBlock = AssistantMessage["content"][number];

function isAssistantModelContentBlock(value: unknown): value is AssistantModelContentBlock {
  const block = asOptionalRecord(value);
  if (!block) {
    return false;
  }
  if (block.type === "text") {
    return typeof block.text === "string";
  }
  if (block.type === "thinking") {
    return typeof block.thinking === "string";
  }
  return (
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    asOptionalRecord(block.arguments) !== undefined
  );
}

export function retainAssistantModelContent(
  blocks: readonly unknown[],
): AssistantMessage["content"] {
  return blocks.filter(isAssistantModelContentBlock).map((block) => Object.assign({}, block));
}

export function readAssistantDisplayContent(message: unknown): Record<string, unknown>[] {
  const record = asOptionalRecord(message);
  if (!record) {
    return [];
  }
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(display) ? display : record.content;
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const entry = asOptionalRecord(block);
        return entry ? [entry] : [];
      })
    : [];
}

export function projectAssistantDisplayContent(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const display = message[ASSISTANT_DISPLAY_CONTENT_FIELD];
  if (message.role !== "assistant" || !Array.isArray(display)) {
    return message;
  }
  const { [ASSISTANT_DISPLAY_CONTENT_FIELD]: _, ...rest } = message;
  return { ...rest, content: display };
}
