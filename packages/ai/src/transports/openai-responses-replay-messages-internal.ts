import type { Api, AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "../providers/tool-result-text.js";
import { shortHash } from "../utils/hash.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./host-policy.js";
import {
  buildOpenAIResponsesReplayContext,
  buildOpenAIResponsesCompactionReplayPlan,
  isOpenAIResponsesReplayContext,
  isSafeResponsesReplayItemId,
  openAIResponsesReplayContextMatches,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import {
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesReasoningReplayMetadata,
  type OpenAIResponsesReplayContext,
  type ReplayableResponseOutputMessage,
  type ReplayableResponseReasoningItem,
} from "./openai-responses-contracts.js";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";
import {
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

export function stripEncryptedReasoningContentFields(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripEncryptedReasoningContentFields(item);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  const source = value as Record<string, unknown>;
  if (source.type === "compaction") {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const stripped = stripEncryptedReasoningContentFields(child);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

function isOpenAIResponsesReasoningReplayMetadata(
  value: unknown,
): value is OpenAIResponsesReasoningReplayMetadata {
  if (!isOpenAIResponsesReplayContext(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.v === 1 && record.source === "openai-responses";
}

function readOpenAIResponsesReasoningReplayBlockMetadata(
  block: Record<string, unknown>,
): OpenAIResponsesReasoningReplayMetadata | null | undefined {
  if (!Object.hasOwn(block, OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY)) {
    return undefined;
  }
  const value = block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY];
  return isOpenAIResponsesReasoningReplayMetadata(value) ? value : null;
}

function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
): ReplayableResponseReasoningItem {
  const record = item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (record.type !== "reasoning" || Array.isArray(record.summary)) {
    return item;
  }
  return { ...record, summary: [] } as ReplayableResponseReasoningItem;
}

function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: OpenAIResponsesReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata | null,
  options?: { preserveUnattributedEncryptedContent?: boolean },
): ReplayableResponseReasoningItem {
  const record = item as ReplayableResponseReasoningItem & Record<string, unknown>;
  const hasRawMetadata = Object.hasOwn(record, OPENAI_RESPONSES_REASONING_REPLAY_META_KEY);
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } = record;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const metadata =
    blockMetadata !== undefined
      ? (blockMetadata ?? undefined)
      : isOpenAIResponsesReasoningReplayMetadata(rawMetadata)
        ? rawMetadata
        : undefined;
  const preserveUnattributed =
    blockMetadata === undefined &&
    !hasRawMetadata &&
    options?.preserveUnattributedEncryptedContent === true;
  if (
    preserveUnattributed ||
    (metadata && openAIResponsesReplayContextMatches(metadata, context))
  ) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const stripped = stripEncryptedReasoningContentFields(rest);
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripped.value as ReplayableResponseReasoningItem,
  );
}

function normalizeResponsesReplayItemId(
  id: string | undefined,
  prefix: string,
): string | undefined {
  if (!id) {
    return undefined;
  }
  if (id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH) {
    return id;
  }
  return `${prefix}_${shortHash(id)}`;
}

export function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseOpenAIResponsesTextSignature(
  signature: string | undefined,
): { id?: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return { id, phase };
        }
        return undefined;
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

export function buildResponsesInputMessage(
  role: "user" | "system" | "developer",
  content: ResponseInputMessageContentList,
): ResponseInputItem.Message {
  return { type: "message", role, content };
}

export function createOpenAIResponsesAssistantOutput(
  model: Model,
  api: Api = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type ConvertResponsesMessagesOptions = {
  includeSystemPrompt?: boolean;
  replayReasoningItems?: boolean;
  replayResponsesItemIds?: boolean;
  sessionId?: string;
  authProfileId?: string;
  replayMode?: OpenAIResponsesReplayMode;
};

function convertResponsesMessagesWithStyle(
  model: Model,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options: ConvertResponsesMessagesOptions | undefined,
  conversionStyle: "provider" | "transport",
): ResponseInput {
  const messages: ResponseInput = [];
  const providerStyle = conversionStyle === "provider";
  const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
  const replayContext = buildOpenAIResponsesReplayContext(model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
  });
  const shouldNormalizeSameModelToolCallIds = model.provider === "github-copilot";
  const sanitizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    return providerStyle ? sanitized : sanitized.replace(/_+$/, "");
  };
  const normalizeIdPart = (part: string) => {
    const sanitized = sanitizeIdPart(part);
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const buildSameProviderCopilotResponsesItemId = (itemId: string) => {
    const sanitized = sanitizeIdPart(itemId);
    const candidate = sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`;
    return candidate.length > 64 ? buildForeignResponsesItemId(itemId) : candidate;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const separatorIndex = id.indexOf("|");
    const callId = id.slice(0, separatorIndex);
    const itemId = id.slice(separatorIndex + 1);
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : model.provider === "github-copilot"
        ? providerStyle
          ? normalizeIdPart(itemId)
          : buildSameProviderCopilotResponsesItemId(itemId)
        : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const replayPlan = buildOpenAIResponsesCompactionReplayPlan(context.messages, model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    mode: options?.replayMode,
  });
  const transformMessages = (source: Context["messages"]) =>
    providerStyle
      ? transformProviderMessages(source, model, normalizeToolCallId)
      : transformTransportMessages(source, model, normalizeToolCallId, {
          normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds,
          preserveUnframedToolResults: replayPlan.preserveUnframedToolResults,
        });
  const transformedMessages = transformMessages(replayPlan.messages);
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push(
      buildResponsesInputMessage(
        model.reasoning &&
          (model.compat as { supportsDeveloperRole?: boolean } | undefined)
            ?.supportsDeveloperRole !== false
          ? "developer"
          : "system",
        [
          {
            type: "input_text",
            text: sanitizeTransportPayloadText(
              stripSystemPromptCacheBoundary(context.systemPrompt),
            ),
          },
        ],
      ),
    );
  }
  // The compact endpoint's output is already canonical provider input, not
  // internal user content to normalize or reinterpret as text/image blocks.
  if (replayPlan.compactedWindow) {
    messages.push(...replayPlan.compactedWindow);
  }
  let replayMessages = replayPlan.compaction
    ? [replayPlan.compaction, ...transformedMessages]
    : transformedMessages;
  // Responses continuation requires the complete prior input before tool output.
  // Anchor context after the user or its compaction checkpoint, not each tool round.
  // Other transports retain their tail placement for cross-turn prompt caching.
  const isCarrier = (message: (typeof replayMessages)[number]) =>
    "role" in message && message.role === "user" && message.runtimeContextCarrier === true;
  const carriers = replayMessages.filter(isCarrier);
  if (carriers.length > 0) {
    const stableMessages = replayMessages.filter((message) => !isCarrier(message));
    const insertionIndex =
      stableMessages.findLastIndex((message) =>
        "role" in message ? message.role === "user" : message.type === "compaction",
      ) + 1;
    // A canonical window is already emitted above; its checkpoint anchors an otherwise userless tail.
    if (insertionIndex > 0 || replayPlan.compactedWindow) {
      replayMessages = [
        ...stableMessages.slice(0, insertionIndex),
        ...carriers,
        ...stableMessages.slice(insertionIndex),
      ];
    }
  }
  let msgIndex = 0;
  for (const msg of replayMessages) {
    if (!("role" in msg)) {
      messages.push(msg);
      continue;
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push(
          buildResponsesInputMessage("user", [
            { type: "input_text", text: sanitizeTransportPayloadText(msg.content) },
          ]),
        );
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter(
          (item) => providerStyle || model.input.includes("image") || item.type !== "input_image",
        );
        if (content.length > 0) {
          messages.push(buildResponsesInputMessage("user", content));
        } else if (providerStyle) {
          continue;
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      let textFallbackOrdinal = 0;
      let previousReplayItemWasReasoning = false;
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (
            shouldReplayReasoningItems &&
            block.thinkingSignature &&
            (providerStyle || block.thinkingSignature.startsWith("{"))
          ) {
            // Persisted signatures are provider-owned data. Skip malformed or unrelated
            // shapes so one corrupt history item cannot prevent the next request.
            let reasoningItem: unknown;
            try {
              reasoningItem = JSON.parse(block.thinkingSignature);
            } catch {
              continue;
            }
            if (!isRecord(reasoningItem) || reasoningItem.type !== "reasoning") {
              continue;
            }
            const replayableReasoningItem = prepareOpenAIResponsesReasoningItemForReplay(
              reasoningItem as ReplayableResponseReasoningItem,
              replayContext,
              readOpenAIResponsesReasoningReplayBlockMetadata(isRecord(block) ? block : {}),
              providerStyle ? { preserveUnattributedEncryptedContent: true } : undefined,
            );
            if (!shouldReplayResponsesItemIds) {
              delete replayableReasoningItem.id;
            }
            if (
              shouldReplayResponsesItemIds &&
              !providerStyle &&
              model.provider === "github-copilot" &&
              !isSafeResponsesReplayItemId(replayableReasoningItem.id)
            ) {
              continue;
            }
            output.push(replayableReasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textSignature = parseOpenAIResponsesTextSignature(block.textSignature);
          let msgId = resolveReplayableResponsesMessageId({
            replayResponsesItemIds: shouldReplayResponsesItemIds,
            textSignatureId: textSignature?.id,
            fallbackId: `msg_${msgIndex}`,
            fallbackOrdinal: textFallbackOrdinal,
            previousReplayItemWasReasoning,
          });
          if (!textSignature?.id) {
            textFallbackOrdinal += 1;
          }
          msgId = normalizeResponsesReplayItemId(msgId, "msg");
          const messageItem: ReplayableResponseOutputMessage = {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            ...(msgId ? { id: msgId } : {}),
            phase: textSignature?.phase,
          };
          output.push(messageItem as ResponseInputItem);
          previousReplayItemWasReasoning = false;
        } else if (block.type === "toolCall") {
          const separatorIndex = block.id.indexOf("|");
          const callId = separatorIndex === -1 ? block.id : block.id.slice(0, separatorIndex);
          const itemIdRaw = separatorIndex === -1 ? undefined : block.id.slice(separatorIndex + 1);
          const itemId =
            shouldReplayResponsesItemIds && !(isDifferentModel && itemIdRaw?.startsWith("fc_"))
              ? itemIdRaw
              : undefined;
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments: providerStyle
              ? JSON.stringify(block.arguments)
              : typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      } else if (providerStyle) {
        continue;
      }
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const sanitizedTextResult = sanitizeTransportPayloadText(textResult);
      const hasText = sanitizedTextResult.trim().length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasImages = msg.content.some(isImageWithMediaPayload);
      const separatorIndex = msg.toolCallId.indexOf("|");
      const callId =
        separatorIndex === -1 ? msg.toolCallId : msg.toolCallId.slice(0, separatorIndex);
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(hasText
                  ? [{ type: "input_text", text: sanitizedTextResult }]
                  : mediaPlaceholder === "(see attached media)"
                    ? [{ type: "input_text", text: mediaPlaceholder }]
                    : []),
                ...msg.content.filter(isImageWithMediaPayload).map((item) => ({
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeNonEmptyTransportPayloadText(textResult, mediaPlaceholder ?? "(no output)"),
      });
    }
    msgIndex += 1;
  }
  return messages;
}

export function convertResponsesMessages(
  model: Model,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  return convertResponsesMessagesWithStyle(
    model,
    context,
    allowedToolCallProviders,
    options,
    "transport",
  );
}

export function convertProviderResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: {
    includeSystemPrompt?: boolean;
    replayResponsesItemIds?: boolean;
    sessionId?: string;
    authProfileId?: string;
    replayMode?: OpenAIResponsesReplayMode;
  },
): ResponseInput {
  return convertResponsesMessagesWithStyle(
    model,
    context,
    allowedToolCallProviders,
    options,
    "provider",
  );
}
