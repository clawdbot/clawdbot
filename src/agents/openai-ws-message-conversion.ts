import { randomUUID } from "node:crypto";
import type { Context, Message, StopReason } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  encodeAssistantTextSignature,
  normalizeAssistantPhase,
  parseAssistantTextSignature,
} from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";
import type {
  ContentPart,
  FunctionToolDefinition,
  InputItem,
  OpenAIResponsesAssistantPhase,
  ResponseObject,
} from "./openai-ws-connection.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { normalizeUsage } from "./usage.js";

type AnyMessage = Message & { role: string; content: unknown };
type AssistantMessageWithPhase = AssistantMessage & { phase?: OpenAIResponsesAssistantPhase };
export type ReplayModelInfo = { input?: ReadonlyArray<string>; api?: string };
type ReplayableReasoningItem = Extract<InputItem, { type: "reasoning" }>;
type ReplayableReasoningSignature = {
  type: "reasoning" | `reasoning.${string}`;
  id?: string;
};
type ToolCallReplayId = { callId: string; itemId?: string };
export type PlannedTurnInput = {
  inputItems: InputItem[];
  previousResponseId?: string;
  mode: "incremental_tool_results" | "full_context_initial" | "full_context_restart";
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function supportsImageInput(modelOverride?: ReplayModelInfo): boolean {
  return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}

function usesOpenAICompletionsImageParts(modelOverride?: ReplayModelInfo): boolean {
  return modelOverride?.api === "openai-completions";
}

function toImageUrlFromBase64(params: { mediaType?: string; data: string }): string {
  return `data:${params.mediaType ?? "image/jpeg"};base64,${params.data}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object",
    )
    .filter(
      (part) =>
        (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function contentToOpenAIParts(content: unknown, modelOverride?: ReplayModelInfo): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const includeImages = supportsImageInput(modelOverride);
  const useImageUrl = usesOpenAICompletionsImageParts(modelOverride);
  const parts: ContentPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    source?: unknown;
  }>) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    if (!includeImages) {
      continue;
    }

    if (part.type === "image" && typeof part.data === "string") {
      if (useImageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: toImageUrlFromBase64({ mediaType: part.mimeType, data: part.data }),
          },
        });
        continue;
      }
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
      continue;
    }

    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      typeof (part.source as { type?: unknown }).type === "string"
    ) {
      const source = part.source as
        | { type: "url"; url: string }
        | { type: "base64"; media_type: string; data: string };
      if (useImageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url:
              source.type === "url"
                ? source.url
                : toImageUrlFromBase64({ mediaType: source.media_type, data: source.data }),
          },
        });
        continue;
      }
      parts.push({
        type: "input_image",
        source,
      });
    }
  }
  return parts;
}

function isReplayableReasoningType(value: unknown): value is "reasoning" | `reasoning.${string}` {
  return typeof value === "string" && (value === "reasoning" || value.startsWith("reasoning."));
}

function toReplayableReasoningId(value: unknown): string | null {
  const id = toNonEmptyString(value);
  return id && id.startsWith("rs_") ? id : null;
}

function toReasoningSignature(value: unknown): ReplayableReasoningSignature | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { type?: unknown; id?: unknown };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  return {
    type: record.type,
    ...(reasoningId ? { id: reasoningId } : {}),
  };
}

function encodeThinkingSignature(signature: ReplayableReasoningSignature): string {
  return JSON.stringify(signature);
}

function parseReasoningItem(value: unknown): ReplayableReasoningItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    type?: unknown;
    id?: unknown;
    content?: unknown;
    encrypted_content?: unknown;
    summary?: unknown;
  };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  return {
    type: "reasoning",
    ...(reasoningId ? { id: reasoningId } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.encrypted_content === "string"
      ? { encrypted_content: record.encrypted_content }
      : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function parseThinkingSignature(value: unknown): ReplayableReasoningItem | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const signature = toReasoningSignature(JSON.parse(value));
    return signature ? parseReasoningItem(signature) : null;
  } catch {
    return null;
  }
}

function encodeToolCallReplayId(params: ToolCallReplayId): string {
  return params.itemId ? `${params.callId}|${params.itemId}` : params.callId;
}

function decodeToolCallReplayId(value: unknown): ToolCallReplayId | null {
  const raw = toNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const [callId, itemId] = raw.split("|", 2);
  return {
    callId,
    ...(itemId ? { itemId } : {}),
  };
}

function extractReasoningSummaryText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { text?: unknown };
      return normalizeOptionalString(record.text) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractResponseReasoningText(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const record = item as { summary?: unknown; content?: unknown };
  const summaryText = extractReasoningSummaryText(record.summary);
  if (summaryText) {
    return summaryText;
  }
  return normalizeOptionalString(record.content) ?? "";
}

export function convertTools(
  tools: Context["tools"],
  options?: { strict?: boolean | null },
): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  const strict = resolveOpenAIStrictToolFlagForInventory(tools, options?.strict);
  return tools.map((tool) => {
    return {
      type: "function" as const,
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: normalizeOpenAIStrictToolParameters(
        tool.parameters ?? {},
        strict === true,
      ) as Record<string, unknown>,
      ...(strict === undefined ? {} : { strict }),
    };
  });
}

export function planTurnInput(params: {
  context: Context;
  model: ReplayModelInfo;
  previousResponseId: string | null;
  lastContextLength: number;
}): PlannedTurnInput {
  if (params.previousResponseId && params.lastContextLength > 0) {
    const newMessages = params.context.messages.slice(params.lastContextLength);
    const toolResults = newMessages.filter(
      (message) => (message as AnyMessage).role === "toolResult",
    );
    if (toolResults.length > 0) {
      return {
        mode: "incremental_tool_results",
        previousResponseId: params.previousResponseId,
        inputItems: convertMessagesToInputItems(toolResults, params.model),
      };
    }
    return {
      mode: "full_context_restart",
      inputItems: convertMessagesToInputItems(params.context.messages, params.model),
    };
  }

  return {
    mode: "full_context_initial",
    inputItems: convertMessagesToInputItems(params.context.messages, params.model),
  };
}

export function convertMessagesToInputItems(
  messages: Message[],
  modelOverride?: ReplayModelInfo,
): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage & {
      phase?: unknown;
      toolCallId?: unknown;
      toolUseId?: unknown;
    };

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content, modelOverride);
      if (parts.length === 0) {
        continue;
      }
      items.push({
        type: "message",
        role: "user",
        content:
          parts.length === 1 && parts[0]?.type === "input_text"
            ? (parts[0] as { type: "input_text"; text: string }).text
            : parts,
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = m.content;
      const assistantMessagePhase = normalizeAssistantPhase(m.phase);
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        let currentTextPhase: OpenAIResponsesAssistantPhase | undefined;
        const hasExplicitBlockPhase = content.some((block) => {
          if (!block || typeof block !== "object") {
            return false;
          }
          const record = block as { type?: unknown; textSignature?: unknown };
          return (
            record.type === "text" &&
            Boolean(parseAssistantTextSignature(record.textSignature)?.phase)
          );
        });
        const pushAssistantText = (phase?: OpenAIResponsesAssistantPhase) => {
          if (textParts.length === 0) {
            return;
          }
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
            ...(phase ? { phase } : {}),
          });
          textParts.length = 0;
        };

        for (const block of content as Array<{
          type?: string;
          text?: string;
          textSignature?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
          thinkingSignature?: unknown;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            const parsedSignature = parseAssistantTextSignature(block.textSignature);
            const blockPhase =
              parsedSignature?.phase ??
              (parsedSignature?.id
                ? assistantMessagePhase
                : hasExplicitBlockPhase
                  ? undefined
                  : assistantMessagePhase);
            if (textParts.length > 0 && blockPhase !== currentTextPhase) {
              pushAssistantText(currentTextPhase);
            }
            textParts.push(block.text);
            currentTextPhase = blockPhase;
            continue;
          }

          if (block.type === "thinking") {
            pushAssistantText(currentTextPhase);
            const reasoningItem = parseThinkingSignature(block.thinkingSignature);
            if (reasoningItem) {
              items.push(reasoningItem);
            }
            continue;
          }

          if (block.type !== "toolCall") {
            continue;
          }

          pushAssistantText(currentTextPhase);
          const replayId = decodeToolCallReplayId(block.id);
          const toolName = toNonEmptyString(block.name);
          if (!replayId || !toolName) {
            continue;
          }
          items.push({
            type: "function_call",
            ...(replayId.itemId ? { id: replayId.itemId } : {}),
            call_id: replayId.callId,
            name: toolName,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }

        pushAssistantText(currentTextPhase);
        continue;
      }

      const text = contentToText(content);
      if (!text) {
        continue;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: text,
        ...(assistantMessagePhase ? { phase: assistantMessagePhase } : {}),
      });
      continue;
    }

    if (m.role !== "toolResult") {
      continue;
    }

    const toolCallId = toNonEmptyString(m.toolCallId) ?? toNonEmptyString(m.toolUseId);
    if (!toolCallId) {
      continue;
    }
    const replayId = decodeToolCallReplayId(toolCallId);
    if (!replayId) {
      continue;
    }
    const parts = Array.isArray(m.content) ? contentToOpenAIParts(m.content, modelOverride) : [];
    const textOutput = contentToText(m.content);
    const imageParts = parts.filter(
      (part) => part.type === "input_image" || part.type === "image_url",
    );
    items.push({
      type: "function_call_output",
      call_id: replayId.callId,
      output: textOutput || (imageParts.length > 0 ? "(see attached image)" : ""),
    });
    if (imageParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          ...imageParts,
        ],
      });
    }
  }

  return items;
}

export function buildAssistantMessageFromResponse(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  const assistantMessageOutputs = (response.output ?? []).filter(
    (item): item is Extract<ResponseObject["output"][number], { type: "message" }> =>
      item.type === "message",
  );
  const hasExplicitPhasedAssistantText = assistantMessageOutputs.some((item) => {
    const itemPhase = normalizeAssistantPhase(item.phase);
    return Boolean(
      itemPhase && item.content?.some((part) => part.type === "output_text" && Boolean(part.text)),
    );
  });
  const hasFinalAnswerText = assistantMessageOutputs.some((item) => {
    if (normalizeAssistantPhase(item.phase) !== "final_answer") {
      return false;
    }
    return item.content?.some((part) => part.type === "output_text" && Boolean(part.text)) ?? false;
  });
  const includedAssistantPhases = new Set<OpenAIResponsesAssistantPhase>();
  let hasIncludedUnphasedAssistantText = false;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const itemPhase = normalizeAssistantPhase(item.phase);
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          const shouldIncludeText = hasFinalAnswerText
            ? itemPhase === "final_answer"
            : hasExplicitPhasedAssistantText
              ? itemPhase === undefined
              : true;
          if (!shouldIncludeText) {
            continue;
          }
          if (itemPhase) {
            includedAssistantPhases.add(itemPhase);
          } else {
            hasIncludedUnphasedAssistantText = true;
          }
          content.push({
            type: "text",
            text: part.text,
            textSignature: encodeAssistantTextSignature({
              id: item.id,
              ...(itemPhase ? { phase: itemPhase } : {}),
            }),
          });
        }
      }
    } else if (item.type === "function_call") {
      const toolName = toNonEmptyString(item.name);
      if (!toolName) {
        continue;
      }
      const callId = toNonEmptyString(item.call_id);
      const itemId = toNonEmptyString(item.id);
      content.push({
        type: "toolCall",
        id: encodeToolCallReplayId({
          callId: callId ?? `call_${randomUUID()}`,
          itemId: itemId ?? undefined,
        }),
        name: toolName,
        arguments: (() => {
          try {
            return JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            return item.arguments as unknown as Record<string, unknown>;
          }
        })(),
      });
    } else {
      if (!isReplayableReasoningType(item.type)) {
        continue;
      }
      const reasoning = extractResponseReasoningText(item);
      if (!reasoning) {
        continue;
      }
      const reasoningId = toReplayableReasoningId(item.id);
      content.push({
        type: "thinking",
        thinking: reasoning,
        ...(reasoningId
          ? {
              thinkingSignature: encodeThinkingSignature({
                id: reasoningId,
                type: item.type,
              }),
            }
          : {}),
      } as AssistantMessage["content"][number]);
    }
  }

  const hasToolCalls = content.some((part) => part.type === "toolCall");
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";
  const normalizedUsage = normalizeUsage(response.usage);
  const rawTotalTokens = normalizedUsage?.total;
  const resolvedTotalTokens =
    rawTotalTokens && rawTotalTokens > 0
      ? rawTotalTokens
      : (normalizedUsage?.input ?? 0) +
        (normalizedUsage?.output ?? 0) +
        (normalizedUsage?.cacheRead ?? 0) +
        (normalizedUsage?.cacheWrite ?? 0);

  const message = buildAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: normalizedUsage?.input ?? 0,
      output: normalizedUsage?.output ?? 0,
      cacheRead: normalizedUsage?.cacheRead ?? 0,
      cacheWrite: normalizedUsage?.cacheWrite ?? 0,
      totalTokens: resolvedTotalTokens > 0 ? resolvedTotalTokens : undefined,
    }),
  });

  const finalAssistantPhase =
    includedAssistantPhases.size === 1 && !hasIncludedUnphasedAssistantText
      ? [...includedAssistantPhases][0]
      : undefined;

  return finalAssistantPhase
    ? ({ ...message, phase: finalAssistantPhase } as AssistantMessageWithPhase)
    : message;
}

export function convertResponseToInputItems(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string; input?: ReadonlyArray<string> },
): InputItem[] {
  return convertMessagesToInputItems(
    [buildAssistantMessageFromResponse(response, modelInfo)] as Message[],
    modelInfo,
  );
}
