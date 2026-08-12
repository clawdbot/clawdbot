import { resolveModelBoundThinkingReplayMode } from "./providers/anthropic-model-contract.js";
import { isImageWithMediaPayload } from "./providers/tool-result-text.js";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
} from "./types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];

  for (const block of content) {
    if (block.type !== "image") {
      result.push(block);
      continue;
    }
    const previous = result.at(-1);
    const repeated = previous?.type === "text" && previous.text === placeholder;
    if (isImageWithMediaPayload(block) && !repeated) {
      result.push({ type: "text", text: placeholder });
    }
  }

  return result;
}

function downgradeUnsupportedImages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
): Message[] {
  if (model.input.includes("image")) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role === "assistant" || typeof message.content === "string") {
      return message;
    }
    const placeholder =
      message.role === "user"
        ? NON_VISION_USER_IMAGE_PLACEHOLDER
        : NON_VISION_TOOL_IMAGE_PLACEHOLDER;
    return { ...message, content: replaceImagesWithPlaceholder(message.content, placeholder) };
  });
}

function transformAssistant<TApi extends Api>(
  message: AssistantMessage,
  model: Model<TApi>,
  toolCallIdMap: Map<string, string>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): AssistantMessage {
  const replayMode = resolveModelBoundThinkingReplayMode({
    source: {
      provider: message.provider,
      api: message.api,
      modelId: message.model,
      responseModelId: message.responseModel,
    },
    target: {
      provider: model.provider,
      api: model.api,
      modelId: model.id,
      modelParams: model.params,
    },
  });
  const sameModel =
    replayMode === "preserve" ||
    (message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id);
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
  const content = blocks.flatMap((block) => {
    if (block.type === "thinking") {
      if (replayMode === "drop") {
        return [];
      }
      if (block.redacted) {
        return sameModel ? block : [];
      }
      if (sameModel && block.thinkingSignature) {
        return block;
      }
      if (!block.thinking?.trim()) {
        return [];
      }
      return sameModel ? block : { type: "text" as const, text: block.thinking };
    }
    if (block.type === "text") {
      return sameModel ? block : { type: "text" as const, text: block.text };
    }
    const { thoughtSignature: _, ...unsigned } = block;
    // Pairing uses these IDs as shared keys, before model-specific normalization runs.
    const trimmedId = block.id.trim();
    if (sameModel) {
      return trimmedId === block.id ? block : Object.assign({}, block, { id: trimmedId });
    }
    const id = normalizeToolCallId?.(trimmedId, model, message) ?? trimmedId;
    if (id !== trimmedId) {
      toolCallIdMap.set(trimmedId, id);
    }
    return id === block.id ? unsigned : Object.assign({}, unsigned, { id });
  });
  return { ...message, content };
}

export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const normalized = messages.map((message) =>
    message.content == null ? Object.assign({}, message, { content: [] }) : message,
  );
  const transformed = downgradeUnsupportedImages(normalized, model).map((message) => {
    if (message.role === "assistant") {
      return transformAssistant(message, model, toolCallIdMap, normalizeToolCallId);
    }
    if (message.role !== "toolResult") {
      return message;
    }
    const trimmedId = message.toolCallId.trim();
    const toolCallId = toolCallIdMap.get(trimmedId) ?? trimmedId;
    return toolCallId === message.toolCallId ? message : Object.assign({}, message, { toolCallId });
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const flushToolCalls = () => {
    for (const call of pendingToolCalls) {
      if (!existingToolResultIds.has(call.id)) {
        result.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      flushToolCalls();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      pendingToolCalls = message.content.filter((block) => block.type === "toolCall");
    } else if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
    } else {
      flushToolCalls();
    }
    result.push(message);
  }
  flushToolCalls();
  return result;
}
