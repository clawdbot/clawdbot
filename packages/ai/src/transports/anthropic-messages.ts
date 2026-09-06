import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageCreateParamsStreaming,
  Tool as AnthropicTool,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { Context, Model, Tool } from "@openclaw/llm-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import {
  requiresClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
} from "../providers/anthropic-model-contract.js";
import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "../providers/anthropic-thinking-replay.js";
import {
  toClaudeCodeToolName,
  normalizeAnthropicToolChoice,
  reconcileAnthropicToolChoice,
  projectAnthropicTools,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
  isImageWithMediaPayload,
} from "../providers/tool-result-text.js";
import type { AnthropicCompactionBlock } from "./anthropic-compaction-replay.js";
import {
  coerceTransportToolCallArguments,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

type AnthropicReplayBlock =
  | ContentBlockParam
  | AnthropicCompactionBlock
  | {
      type: "redacted_thinking";
      data?: string;
    };

type AnthropicWireMessage = {
  role: "user" | "assistant";
  content: string | AnthropicReplayBlock[];
  reasoning_content?: string;
};

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

async function convertContentBlocks(
  content: readonly unknown[],
  model: { input: readonly string[] },
  imageBudget: AnthropicInlineImageBudget,
  profile: "provider" | "transport",
  isError: boolean,
) {
  const text = extractToolResultText(content);
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages =
    (profile === "provider" || model.input.includes("image")) &&
    content.some(isImageWithMediaPayload);
  if (!hasImages) {
    return sanitizeNonEmptyTransportPayloadText(
      text,
      mediaPlaceholder ??
        (profile === "transport" ? "(no output)" : isError ? "[tool error with no output]" : ""),
    );
  }
  const blocks: Array<TextBlockParam | ImageBlockParam> = [];
  let hasTextBlock = false;
  for (const block of content) {
    const record = asOptionalObjectRecord(block);
    if (!record) {
      continue;
    }
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text", text: sanitizeTransportPayloadText(blockText) });
      hasTextBlock = true;
    }
    if (!isImageWithMediaPayload(record)) {
      continue;
    }
    const [normalizedImage] = await normalizeAnthropicInlineContent(
      [
        {
          type: "image" as const,
          data: typeof record.data === "string" ? record.data : "",
          mimeType:
            typeof record.mimeType === "string"
              ? record.mimeType
              : profile === "provider"
                ? "image/jpeg"
                : "image/png",
        },
      ],
      imageBudget,
    );
    if (normalizedImage?.type !== "image") {
      continue;
    }
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64",
        media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
        data: normalizedImage.data,
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text", text: mediaPlaceholder ?? "(see attached image)" });
  }
  return blocks;
}

export async function convertAnthropicMessages(
  transformedMessages: Context["messages"],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
  options: {
    allowReasoningContentReplay?: boolean;
    compaction?: AnthropicCompactionBlock;
    replayThinkingEnabled?: boolean;
    allowEmptySignature?: boolean;
    profile: "provider" | "transport";
  },
): Promise<AnthropicWireMessage[]> {
  const params: AnthropicWireMessage[] = [];
  const imageBudget = createAnthropicInlineImageBudget();
  const allowReasoningContentReplay = options.allowReasoningContentReplay === true;
  const replayThinkingEnabled = options.replayThinkingEnabled !== false;
  const managed = options.profile === "transport";
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          const userParam: AnthropicWireMessage = {
            role: "user",
            content: sanitizeTransportPayloadText(msg.content),
          };
          params.push(userParam);
        }
        continue;
      }
      const normalizedContent =
        !managed || model.input.includes("image")
          ? await normalizeAnthropicInlineContent(msg.content, imageBudget)
          : msg.content.map((item) =>
              item.type === "image"
                ? { type: "text" as const, text: NON_VISION_USER_IMAGE_PLACEHOLDER }
                : item,
            );
      const blocks: Array<TextBlockParam | ImageBlockParam> = normalizedContent.map((item) =>
        item.type === "text"
          ? {
              type: "text",
              text: sanitizeTransportPayloadText(item.text),
            }
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: resolveAnthropicImageMediaType(item.mimeType),
                data: item.data,
              },
            },
      );
      let filteredBlocks =
        !managed || model.input.includes("image")
          ? blocks
          : blocks.filter((block) => block.type !== "image");
      filteredBlocks = filteredBlocks.filter(
        (block) => block.type !== "text" || block.text.trim().length > 0,
      );
      if (filteredBlocks.length === 0) {
        continue;
      }
      const userParam: AnthropicWireMessage = {
        role: "user",
        content: filteredBlocks,
      };
      params.push(userParam);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicReplayBlock[] =
        i === 0 && options.compaction ? [options.compaction] : [];
      const reasoningContent: string[] = [];
      let omittedThinking = false;
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.text),
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          const thinkingSignature = block.thinkingSignature?.trim();
          const isReasoningContent = thinkingSignature === "reasoning_content";
          if (
            !replayThinkingEnabled &&
            i !== activeToolTurnAssistantIndex &&
            (!managed || !isReasoningContent)
          ) {
            omittedThinking = true;
            continue;
          }
          if (block.redacted) {
            if (!managed && !block.thinkingSignature) {
              throw new Error("redacted thinking block is missing its opaque signature");
            }
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const hasNativeThinkingSignature = Boolean(thinkingSignature) && !isReasoningContent;
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          if (!thinkingSignature && !options.allowEmptySignature) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.thinking),
            });
          } else {
            const thinking =
              thinkingSignature === "reasoning_content"
                ? sanitizeTransportPayloadText(block.thinking)
                : block.thinking;
            if (thinkingSignature === "reasoning_content") {
              if (allowReasoningContentReplay) {
                blocks.push({
                  type: "thinking",
                  thinking,
                  signature: thinkingSignature ?? "",
                });
                reasoningContent.push(thinking);
              }
              continue;
            }
            blocks.push({
              type: "thinking",
              thinking,
              signature: thinkingSignature ?? "",
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeToolName(block.name) : block.name,
            input: managed
              ? coerceTransportToolCallArguments(block.arguments)
              : (block.arguments ?? {}),
          });
        }
      }
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length > 0) {
        const assistantMsg: AnthropicWireMessage = { role: "assistant", content: blocks };
        if (reasoningContent.length > 0) {
          assistantMsg.reasoning_content = reasoningContent.join("\n");
        } else if (allowReasoningContentReplay) {
          blocks.unshift({
            type: "thinking",
            thinking: "",
            signature: "reasoning_content",
          });
        }
        params.push(assistantMsg);
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolResult = msg;
      const toolResults: ToolResultBlockParam[] = [
        {
          type: "tool_result",
          tool_use_id: toolResult.toolCallId,
          content: await convertContentBlocks(
            toolResult.content,
            model,
            imageBudget,
            options.profile,
            toolResult.isError,
          ),
          is_error: toolResult.isError,
        },
      ];
      let j = i + 1;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: await convertContentBlocks(
            nextMsg.content,
            model,
            imageBudget,
            options.profile,
            nextMsg.isError,
          ),
          is_error: nextMsg.isError,
        });
        j += 1;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }
  return params;
}

/** Shared generation contract, after each entry point resolves its defaults and tool policy. */
export function buildAnthropicGenerationParams({
  model,
  options,
  tools,
  toolProjection,
  profile,
}: {
  model: Model<"anthropic-messages">;
  options?: AnthropicOptions;
  tools?: AnthropicTool[];
  toolProjection?: AnthropicToolProjection;
  profile: "provider" | "transport";
}) {
  const params: Pick<
    MessageCreateParamsStreaming,
    | "temperature"
    | "stop_sequences"
    | "tools"
    | "thinking"
    | "output_config"
    | "metadata"
    | "tool_choice"
  > = {};
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  // Thinking and post-4.6 Claude models reject custom temperature values.
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    !supportsClaudeNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  // Configure thinking mode: always-on adaptive (Fable 5 and Mythos 5),
  // adaptive (Opus 4.6+ and Sonnet 4.6),
  // budget-based (older models), or explicitly disabled.
  if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      // Default to "summarized" so Opus 4.7+ and Mythos Preview behave like
      // older Claude 4 models (whose API default is also "summarized").
      const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
      if (supportsClaudeAdaptiveThinking(model)) {
        // Adaptive thinking: Claude decides when and how much to think.
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          params.output_config = { effort };
        }
      } else {
        // Budget-based thinking for older models.
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? 1024,
          ...(profile === "provider" ? { display } : {}),
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    const normalizedToolChoice = normalizeAnthropicToolChoice(
      mandatoryAdaptiveThinking || options?.thinkingEnabled === true,
      options.toolChoice,
    );
    const projectedToolChoice = toolProjection
      ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection)
      : normalizedToolChoice;
    if (projectedToolChoice) {
      params.tool_choice = projectedToolChoice;
    }
  }

  return params;
}

export function convertAnthropicTools(
  tools: Tool[],
  isOAuthTokenLocal: boolean,
  supportsEagerToolInputStreaming = false,
  cacheControl?: CacheControlEphemeral,
): {
  projection: AnthropicToolProjection;
  tools: AnthropicTool[];
} {
  const projection = projectAnthropicTools(tools, (name) =>
    isOAuthTokenLocal ? toClaudeCodeToolName(name) : name,
  );
  const convertedTools: AnthropicTool[] = [];
  for (const [index, tool] of projection.tools.entries()) {
    const convertedTool: AnthropicTool = {
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
    if (supportsEagerToolInputStreaming) {
      convertedTool.eager_input_streaming = true;
    }
    if (cacheControl && index === projection.tools.length - 1) {
      convertedTool.cache_control = cacheControl;
    }
    convertedTools.push(convertedTool);
  }
  return {
    projection,
    tools: convertedTools,
  };
}
