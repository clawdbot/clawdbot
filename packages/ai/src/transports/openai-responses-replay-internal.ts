import type { Api, Context, Model } from "@openclaw/llm-core";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "../providers/tool-result-text.js";
import { shortHash } from "../utils/hash.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./host-policy.js";
import type { createOpenAIResponsesClient } from "./openai-responses-client.js";
import {
  DEFAULT_AZURE_OPENAI_API_VERSION,
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesReasoningReplayMetadata,
  type OpenAIResponsesReplayContext,
  type OpenAIResponsesRequestParams,
  type ReplayableResponseOutputMessage,
  type ReplayableResponseReasoningItem,
} from "./openai-responses-contracts.js";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";
import { log } from "./openai-transport-shared.js";
import {
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

type ResponsesClientLike = ReturnType<typeof createOpenAIResponsesClient>;

export function isInvalidEncryptedContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; status?: unknown };
  if (record.code === "invalid_encrypted_content" || record.code === "thinking_signature_invalid") {
    return true;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return (
    message.includes("invalid_encrypted_content") ||
    message.includes("thinking_signature_invalid") ||
    // xAI reports this exact prose contract without an error code.
    (record.status === 400 &&
      message.toLowerCase().includes("could not decrypt the provided encrypted_content"))
  );
}

function stripEncryptedContentFields(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripEncryptedContentFields(item);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const stripped = stripEncryptedContentFields(child);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

export function stripResponsesRequestEncryptedContent(
  params: OpenAIResponsesRequestParams,
): OpenAIResponsesRequestParams {
  const stripped = stripEncryptedContentFields(params.input);
  if (!stripped.changed) {
    return params;
  }
  return {
    ...params,
    input: stripped.value as ResponseInput,
  };
}

function hashOptionalReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

function buildOpenAIResponsesReplayContext(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashOptionalReplayContextValue(model.baseUrl),
    sessionHash: hashOptionalReplayContextValue(options?.sessionId),
    authProfileHash: hashOptionalReplayContextValue(options?.authProfileId),
  };
}

export function buildOpenAIResponsesReasoningReplayMetadata(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReasoningReplayMetadata {
  return {
    v: 1,
    source: "openai-responses",
    ...buildOpenAIResponsesReplayContext(model, options),
  };
}

export function tagOpenAIResponsesReasoningReplayItem(
  item: Record<string, unknown>,
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): Record<string, unknown> {
  if (!("encrypted_content" in item)) {
    return item;
  }
  return {
    ...item,
    [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
      model,
      options,
    ),
  };
}

function isOpenAIResponsesReasoningReplayMetadata(
  value: unknown,
): value is OpenAIResponsesReasoningReplayMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.source === "openai-responses" &&
    typeof record.provider === "string" &&
    typeof record.api === "string" &&
    typeof record.model === "string" &&
    (record.baseUrlHash === undefined || typeof record.baseUrlHash === "string") &&
    (record.sessionHash === undefined || typeof record.sessionHash === "string") &&
    (record.authProfileHash === undefined || typeof record.authProfileHash === "string")
  );
}

function encryptedReasoningReplayMetadataMatches(
  metadata: OpenAIResponsesReasoningReplayMetadata | undefined,
  context: OpenAIResponsesReplayContext,
): boolean {
  if (!metadata) {
    return false;
  }
  return (
    metadata.provider === context.provider &&
    metadata.api === context.api &&
    metadata.model === context.model &&
    metadata.baseUrlHash === context.baseUrlHash &&
    metadata.sessionHash === context.sessionHash &&
    metadata.authProfileHash === context.authProfileHash
  );
}

function readOpenAIResponsesReasoningReplayBlockMetadata(
  block: Record<string, unknown>,
): OpenAIResponsesReasoningReplayMetadata | undefined {
  const value = block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY];
  return isOpenAIResponsesReasoningReplayMetadata(value) ? value : undefined;
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

export function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: OpenAIResponsesReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata,
): ReplayableResponseReasoningItem {
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } =
    item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const metadata =
    blockMetadata ??
    (isOpenAIResponsesReasoningReplayMetadata(rawMetadata) ? rawMetadata : undefined);
  if (encryptedReasoningReplayMetadataMatches(metadata, context)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const stripped = stripEncryptedContentFields(rest);
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripped.value as ReplayableResponseReasoningItem,
  );
}

export async function createResponsesStreamWithEncryptedContentRetry(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: unknown;
  model: Model;
}): Promise<AsyncIterable<unknown>> {
  try {
    return (await params.client.responses.create(
      params.request as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  } catch (error) {
    const retryRequest = stripResponsesRequestEncryptedContent(params.request);
    if (!isInvalidEncryptedContentError(error) || retryRequest === params.request) {
      throw error;
    }
    log.warn(
      `[responses] retrying without encrypted reasoning content provider=${params.model.provider} ` +
        `api=${params.model.api} model=${params.model.id}`,
    );
    return (await params.client.responses.create(
      retryRequest as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  }
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
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

function isSafeResponsesReplayItemId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH
  );
}

export function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
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

export function convertResponsesMessages(
  model: Model,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: {
    includeSystemPrompt?: boolean;
    supportsDeveloperRole?: boolean;
    replayReasoningItems?: boolean;
    replayResponsesItemIds?: boolean;
    sessionId?: string;
    authProfileId?: string;
  },
): ResponseInput {
  const messages: ResponseInput = [];
  const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
  const replayContext = buildOpenAIResponsesReplayContext(model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
  });
  const shouldNormalizeSameModelToolCallIds = model.provider === "github-copilot";
  const sanitizeIdPart = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "");
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
        ? buildSameProviderCopilotResponsesItemId(itemId)
        : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
    { normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds },
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push(
      buildResponsesInputMessage(
        model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
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
  let msgIndex = 0;
  for (const msg of transformedMessages) {
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
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push(buildResponsesInputMessage("user", content));
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
            block.thinkingSignature.startsWith("{")
          ) {
            // openai-completions plain-text reasoning paths persist a
            // provenance tag (e.g. "reasoning", "reasoning_details", "content")
            // as thinkingSignature rather than a JSON-encoded reasoning item.
            // Replaying those values would corrupt the next request payload
            // (OpenRouter returns HTTP 500), so skip non-JSON signatures.
            const reasoningItem = JSON.parse(
              block.thinkingSignature,
            ) as ReplayableResponseReasoningItem;
            const replayableReasoningItem = prepareOpenAIResponsesReasoningItemForReplay(
              reasoningItem,
              replayContext,
              readOpenAIResponsesReasoningReplayBlockMetadata(
                block as unknown as Record<string, unknown>,
              ),
            );
            if (!shouldReplayResponsesItemIds) {
              delete replayableReasoningItem.id;
            }
            if (
              shouldReplayResponsesItemIds &&
              model.provider === "github-copilot" &&
              !isSafeResponsesReplayItemId(replayableReasoningItem.id)
            ) {
              continue;
            }
            output.push(replayableReasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textSignature = parseTextSignature(block.textSignature);
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
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      if (output.length > 0) {
        messages.push(...output);
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
