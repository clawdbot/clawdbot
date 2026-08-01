import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./providers/tool-result-text.js";
import { transformMessages } from "./transcript-transform.js";
import type { ResolvedOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { Context, Model, TextContent, ThinkingContent, ToolCall } from "./types.js";
import { sanitizeSurrogates } from "./utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "./utils/system-prompt-cache-boundary.js";

const EMPTY_TOOL_RESULT_TEXT = "(no output)";

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
  return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}

function sanitizeToolResultText(text: string, fallback: string): string {
  const sanitized = sanitizeSurrogates(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

/** Convert a normalized transcript to OpenAI Chat Completions messages. */
export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
  options: {
    cacheOptOutIndexes?: Set<number>;
    preserveSystemPromptCacheBoundary?: boolean;
  } = {},
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    // Responses ids can contain a pipe plus a long provider item id. Chat
    // Completions accepts only the call id prefix and caps it at 40 chars.
    if (id.includes("|")) {
      const callId = id.slice(0, id.indexOf("|"));
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") {
      return id.length > 40 ? id.slice(0, 40) : id;
    }
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id),
  );

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    const systemPrompt = options.preserveSystemPromptCacheBoundary
      ? context.systemPrompt
      : stripSystemPromptCacheBoundary(context.systemPrompt);
    params.push({ role, content: sanitizeSurrogates(systemPrompt) });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({ role: "assistant", content: "I have processed the tool results." });
    }

    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        const userParam: ChatCompletionMessageParam = {
          role: "user",
          content: sanitizeSurrogates(msg.content),
        };
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      } else {
        const content: ChatCompletionContentPart[] = msg.content.map(
          (item): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            return {
              type: "image_url",
              image_url: { url: `data:${item.mimeType};base64,${item.data}` },
            } satisfies ChatCompletionContentPartImage;
          },
        );
        if (content.length === 0) {
          continue;
        }
        const userParam: ChatCompletionMessageParam = { role: "user", content };
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const assistantTextParts = msg.content
        .filter(isTextContentBlock)
        .filter((block) => block.text.trim().length > 0)
        .map(
          (block) =>
            ({
              type: "text",
              text: sanitizeSurrogates(block.text),
            }) satisfies ChatCompletionContentPartText,
        );
      const assistantText = assistantTextParts.map((part) => part.text).join("");

      const nonEmptyThinkingBlocks = msg.content
        .filter(isThinkingContentBlock)
        .filter((block) => block.thinking.trim().length > 0);
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          const thinkingText = nonEmptyThinkingBlocks
            .map((block) => sanitizeSurrogates(block.thinking))
            .join("\n\n");
          assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
        } else {
          // String content is the interoperable Chat Completions replay shape;
          // content-part arrays make some compatible servers mirror JSON.
          if (assistantText.length > 0) {
            assistantMsg.content = assistantText;
          }
          let signature = nonEmptyThinkingBlocks.at(0)?.thinkingSignature;
          if (model.provider === "opencode-go" && signature === "reasoning") {
            signature = "reasoning_content";
          }
          if (signature && signature.length > 0) {
            (assistantMsg as typeof assistantMsg & Record<string, unknown>)[signature] =
              nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
          }
        }
      } else if (assistantText.length > 0) {
        assistantMsg.content = assistantText;
      }

      const toolCalls = msg.content.filter(isToolCallBlock);
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
        const reasoningDetails = toolCalls.flatMap((toolCall) => {
          const signature = toolCall.thoughtSignature;
          if (!signature) {
            return [];
          }
          try {
            const parsed: unknown = JSON.parse(signature);
            return parsed ? [parsed] : [];
          } catch {
            return [];
          }
        });
        if (reasoningDetails.length > 0) {
          (
            assistantMsg as typeof assistantMsg & { reasoning_details?: unknown }
          ).reasoning_details = reasoningDetails;
        }
      }
      if (
        compat.requiresReasoningContentOnAssistantMessages &&
        model.reasoning &&
        (assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
      ) {
        (assistantMsg as { reasoning_content?: string }).reasoning_content = "";
      }
      const content = assistantMsg.content;
      const hasContent =
        content !== null &&
        content !== undefined &&
        (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      let j = i;

      while (j < transformedMessages.length) {
        const toolMsg = transformedMessages.at(j);
        if (toolMsg?.role !== "toolResult") {
          break;
        }

        const textResult = extractToolResultText(toolMsg.content);
        const mediaPlaceholder = describeToolResultMediaPlaceholder(toolMsg.content);
        const hasImages = toolMsg.content.some(isImageWithMediaPayload);
        const content = sanitizeToolResultText(
          textResult,
          mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT,
        );
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content,
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          (toolResultMsg as typeof toolResultMsg & { name?: string }).name = toolMsg.toolName;
        }
        params.push(toolResultMsg);

        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (isImageWithMediaPayload(block)) {
              imageBlocks.push({
                type: "image_url",
                image_url: { url: `data:${block.mimeType};base64,${block.data}` },
              });
            }
          }
        }
        j += 1;
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({ role: "assistant", content: "I have processed the tool results." });
        }
        params.push({
          role: "user",
          content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  return params;
}
