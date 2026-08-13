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
  buildOpenAIResponsesReasoningReplayMetadata,
  buildOpenAIResponsesReplayContext,
  buildOpenAIResponsesCompactionReplayPlan,
  isSafeResponsesReplayItemId,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
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
import type { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
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

function stripEncryptedReasoningContentFields(value: unknown): {
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

type ResponsesEncryptedContentRequest = { input?: ResponseInput };

type ResponsesEncryptedContentAttemptKind =
  | "initial"
  | "reasoning-stripped"
  | "compaction-stripped"
  | "continuation-rejected";

export type ResponsesEncryptedContentAttempt<TRequest extends ResponsesEncryptedContentRequest> = {
  kind: ResponsesEncryptedContentAttemptKind;
  request: TRequest;
};

function stripResponsesRequestEncryptedReasoning<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  const stripped = stripEncryptedReasoningContentFields(request.input);
  if (!stripped.changed) {
    return request;
  }
  return {
    ...request,
    input: stripped.value as ResponseInput,
  };
}

function stripResponsesRequestCompaction<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  if (!Array.isArray(request.input)) {
    return request;
  }
  const input = request.input.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "compaction"
      ),
  );
  return input.length === request.input.length ? request : { ...request, input };
}

export async function resolveNextResponsesEncryptedContentAttempt<
  TRequest extends ResponsesEncryptedContentRequest,
>(
  attempt: ResponsesEncryptedContentAttempt<TRequest>,
  error: unknown,
  options?: { buildFullHistoryRequest?: () => TRequest | Promise<TRequest> },
): Promise<ResponsesEncryptedContentAttempt<TRequest> | undefined> {
  if (!isInvalidEncryptedContentError(error) || attempt.kind === "compaction-stripped") {
    return undefined;
  }
  if (attempt.kind === "initial" || attempt.kind === "continuation-rejected") {
    const reasoningStripped = stripResponsesRequestEncryptedReasoning(attempt.request);
    if (reasoningStripped !== attempt.request) {
      return { kind: "reasoning-stripped", request: reasoningStripped };
    }
  }
  const locallyStripped = stripResponsesRequestCompaction(attempt.request);
  if (locallyStripped === attempt.request) {
    return undefined;
  }
  // Filtering the already-pruned checkpoint request would leave a context-blind
  // suffix. Rebuild full history lazily, then preserve any earlier reasoning strip.
  let compactionStripped = options?.buildFullHistoryRequest
    ? await options.buildFullHistoryRequest()
    : locallyStripped;
  compactionStripped = stripResponsesRequestCompaction(compactionStripped);
  if (attempt.kind === "reasoning-stripped") {
    compactionStripped = stripResponsesRequestEncryptedReasoning(compactionStripped);
  }
  return { kind: "compaction-stripped", request: compactionStripped };
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

export function readOpenAIResponsesReasoningReplayBlockMetadata(
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

export function prepareOpenAIResponsesReasoningItemForReplay(
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
  if (preserveUnattributed || encryptedReasoningReplayMetadataMatches(metadata, context)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const stripped = stripEncryptedReasoningContentFields(rest);
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripped.value as ReplayableResponseReasoningItem,
  );
}

export async function createResponsesStreamWithEncryptedContentRetry(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: unknown;
  model: Model;
  observePrompt?: NonNullable<ReturnType<typeof createResponsesPromptEgressObserver>>;
  initialAttemptKind?: "initial" | "continuation-rejected";
  onCompactionRejected?: () => void;
  buildFullHistoryRequest?: () =>
    | OpenAIResponsesRequestParams
    | Promise<OpenAIResponsesRequestParams>;
}): Promise<{
  stream: AsyncIterable<unknown>;
  response: Response;
  attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>;
}> {
  const sendAttempt = async (
    attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>,
  ) => {
    const { data, response } = await params.client.responses
      .create(attempt.request as never, params.requestOptions as never)
      .withResponse();
    if (attempt.kind === "compaction-stripped") {
      params.onCompactionRejected?.();
    }
    return { stream: data as unknown as AsyncIterable<unknown>, response, attempt };
  };

  let attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams> = {
    kind: params.initialAttemptKind ?? "initial",
    request: params.request,
  };
  while (true) {
    params.observePrompt?.(attempt.request, {
      egress: "responses-sdk",
      payloadVariant: attempt.kind,
    });
    try {
      return await sendAttempt(attempt);
    } catch (error) {
      let nextAttempt = await resolveNextResponsesEncryptedContentAttempt(attempt, error, {
        buildFullHistoryRequest: params.buildFullHistoryRequest,
      });
      if (
        !nextAttempt &&
        attempt.request.previous_response_id &&
        error &&
        typeof error === "object" &&
        typeof (error as { status?: unknown }).status === "number" &&
        (error as { code?: unknown }).code === "previous_response_not_found"
      ) {
        const request = {
          ...(params.buildFullHistoryRequest
            ? await params.buildFullHistoryRequest()
            : attempt.request),
        };
        delete request.previous_response_id;
        nextAttempt = { kind: "continuation-rejected", request };
      }
      if (!nextAttempt) {
        throw error;
      }
      const retryDescription =
        nextAttempt.kind === "reasoning-stripped"
          ? "without encrypted reasoning content"
          : nextAttempt.kind === "compaction-stripped"
            ? "without encrypted compaction content"
            : "full history after rejected previous_response_id";
      log.warn(
        `[responses] retrying ${retryDescription} provider=${params.model.provider} ` +
          `api=${params.model.api} model=${params.model.id}`,
      );
      attempt = nextAttempt;
    }
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
    replayMode?: OpenAIResponsesReplayMode;
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
  const replayPlan = buildOpenAIResponsesCompactionReplayPlan(context.messages, model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    mode: options?.replayMode,
  });
  const transformedMessages = transformTransportMessages(
    replayPlan.messages,
    model,
    normalizeToolCallId,
    {
      normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds,
      preserveUnframedToolResults: replayPlan.preserveUnframedToolResults,
    },
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
  if (replayPlan.compaction) {
    messages.push(replayPlan.compaction);
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
