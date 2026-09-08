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
    // Pairing uses these IDs as shared keys, before model-specific normalization runs.
    const trimmedId = block.id.trim();
    if (sameModel) {
      return trimmedId === block.id ? block : Object.assign({}, block, { id: trimmedId });
    }
    const { thoughtSignature: _, async: _async, ...unsigned } = block;
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
  // Other model contracts require ordinary adjacent call/results. Preserve real
  // delayed outcomes before stripping the source model's async capability.
  const asyncOwners = new Map<string, AssistantMessage>();
  const relocated = new Map<AssistantMessage, Message[]>();
  const movedResults = new Set<Message>();
  for (const message of messages) {
    if (message.role === "assistant") {
      const sameModel =
        message.provider === model.provider &&
        message.api === model.api &&
        message.model === model.id;
      for (const block of message.content ?? []) {
        if (block.type === "toolCall") {
          const id = block.id.trim();
          if (block.async && !sameModel) {
            asyncOwners.set(id, message);
          } else {
            asyncOwners.delete(id);
          }
        }
      }
    } else if (message.role === "toolResult") {
      const id = message.toolCallId.trim();
      const owner = asyncOwners.get(id);
      if (owner) {
        const results = relocated.get(owner) ?? [];
        results.push(message);
        relocated.set(owner, results);
        movedResults.add(message);
        asyncOwners.delete(id);
      }
    }
  }
  const source =
    movedResults.size > 0
      ? messages.flatMap((message) =>
          movedResults.has(message)
            ? []
            : [message, ...(message.role === "assistant" ? (relocated.get(message) ?? []) : [])],
        )
      : messages;
  const supportsImages = model.input.includes("image");
  const result: Message[] = [];
  const pendingAsyncCalls = new Map<string, ToolCall>();
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

  for (let message of source) {
    if (message.content == null) {
      message = { ...message, content: [] };
    }
    if (message.role === "assistant") {
      message = transformAssistant(message, model, toolCallIdMap, normalizeToolCallId);
      flushToolCalls();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      pendingToolCalls = message.content.filter((block): block is ToolCall => {
        if (block.type !== "toolCall") {
          return false;
        }
        if (block.async) {
          pendingAsyncCalls.set(block.id, block);
          return false;
        }
        return true;
      });
    } else {
      if (!supportsImages && typeof message.content !== "string") {
        message = {
          ...message,
          content: replaceImagesWithPlaceholder(
            message.content,
            message.role === "user"
              ? NON_VISION_USER_IMAGE_PLACEHOLDER
              : NON_VISION_TOOL_IMAGE_PLACEHOLDER,
          ),
        };
      }
      if (message.role === "toolResult") {
        const trimmedId = message.toolCallId.trim();
        const toolCallId = toolCallIdMap.get(trimmedId) ?? trimmedId;
        if (toolCallId !== message.toolCallId) {
          message = { ...message, toolCallId };
        }
        existingToolResultIds.add(toolCallId);
        pendingAsyncCalls.delete(toolCallId);
      } else {
        flushToolCalls();
      }
    }
    result.push(message);
  }
  // Async calls may own results after later assistant fragments. Only a closed
  // history without their result needs the ordinary missing-result repair.
  pendingToolCalls.push(...pendingAsyncCalls.values());
  flushToolCalls();
  return result;
}
