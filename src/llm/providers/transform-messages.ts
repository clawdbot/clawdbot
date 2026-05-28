import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "../types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;

  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }

    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
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

  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }

    if (msg.role === "toolResult") {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }

    return msg;
  });
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  // Build a map of original tool call IDs to normalized IDs
  const toolCallIdMap = new Map<string, string>();
  const imageAwareMessages = downgradeUnsupportedImages(messages, model);

  // First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
  const transformed = imageAwareMessages.map((msg) => {
    // User messages pass through unchanged
    if (msg.role === "user") {
      return msg;
    }

    // Handle toolResult messages - normalize toolCallId if we have a mapping
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return Object.assign({}, msg, { toolCallId: normalizedId });
      }
      return msg;
    }

    // Assistant messages need transformation check
    if (msg.role === "assistant") {
      const assistantMsg = msg;
      const isSameModel =
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;

      const transformedContent = assistantMsg.content.flatMap((block) => {
        if (block.type === "thinking") {
          // Redacted thinking is opaque encrypted content, only valid for the same model.
          // Drop it for cross-model to avoid API errors.
          if (block.redacted) {
            return isSameModel ? block : [];
          }
          // For same model: keep thinking blocks with signatures (needed for replay)
          // even if the thinking text is empty (OpenAI encrypted reasoning)
          if (isSameModel && block.thinkingSignature) {
            return block;
          }
          // Skip empty thinking blocks, convert others to plain text
          if (!block.thinking || block.thinking.trim() === "") {
            return [];
          }
          if (isSameModel) {
            return block;
          }
          return {
            type: "text" as const,
            text: block.thinking,
          };
        }

        if (block.type === "text") {
          if (isSameModel) {
            return block;
          }
          return {
            type: "text" as const,
            text: block.text,
          };
        }

        if (block.type === "toolCall") {
          const toolCall = block;
          let normalizedToolCall: ToolCall = toolCall;

          if (!isSameModel && toolCall.thoughtSignature) {
            normalizedToolCall = Object.assign({}, toolCall);
            delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
          }

          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              normalizedToolCall = Object.assign({}, normalizedToolCall, { id: normalizedId });
            }
          }

          return normalizedToolCall;
        }

        return block;
      });

      return Object.assign({}, assistantMsg, { content: transformedContent });
    }
    return msg;
  });

  // Second pass: insert synthetic empty tool results for orphaned tool calls
  // This preserves thinking signatures and satisfies API requirements
  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
  };

  for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];

    if (msg.role === "assistant") {
      // If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
      insertSyntheticToolResults();

      // Skip errored/aborted assistant messages entirely.
      // These are incomplete turns that shouldn't be replayed:
      // - May have partial content (reasoning without message, incomplete tool calls)
      // - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
      // - The model should retry from the last valid state
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }

      // Track tool calls from this assistant message
      const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
      // User message interrupts tool flow - insert synthetic results for orphaned calls
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // If the conversation ends with unresolved tool calls, synthesize results now.
  insertSyntheticToolResults();

  return result;
}
