import { randomUUID } from "node:crypto";
import type { Context, Model, StreamFn } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import {
  convertMessages,
  isOpenAIGpt54MiniModel,
  isOpenAIGpt55Model,
  isOpenAIGpt56Model,
  mapOpenAIStopReason,
  normalizeOpenAIStrictToolParameters,
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  resolveOpenAIReasoningEffortForModel,
  type OpenAIReasoningEffort,
} from "../internal/openai.js";
import {
  applyProviderReportedUsageCost,
  calculateCost,
  createFirstStreamEventAbortController,
  createReasoningTagTextPartitioner,
  getEnvApiKey,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  parseStreamingJson,
  withFirstStreamEventTimeout,
} from "../internal/runtime.js";
import { stripSystemPromptCacheBoundary } from "../internal/shared.js";
import {
  clearPendingCommentaryText,
  rememberPendingCommentaryTags,
  tagPendingCommentaryText,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { createDeepSeekTextFilter } from "./deepseek-text-filter.js";
import {
  buildGuardedModelFetch,
  resolveOpenAIStrictToolSetting,
  resolveProviderEndpoint,
} from "./host-policy.js";
import { resolveMaxTokensParam } from "./model-max-tokens-params.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  flattenCompletionMessagesToStringContent,
  stripCompletionMessagesToRoleContent,
} from "./openai-completions-string-content.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
  resolveOpenAIStrictToolFlagWithDiagnostics,
} from "./openai-transport-params.js";
import {
  GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP,
  createModelStreamCooperativeScheduler,
  log,
  resolveCacheRetention,
  resolvePromptCacheKey,
  sortTransportToolsByName,
  throwIfModelStreamAborted,
  type MutableAssistantOutput,
  type OpenAICompletionsOptions,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import { failTransportStream, finalizeTransportStream } from "./transport-stream-shared.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  supportsModelTools,
} from "./transport-utils.js";

function hasToolHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      // Assistant content can be a raw string from transcript replay; a string
      // never carries tool calls, so it should not count toward tool history.
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "toolCall")),
  );
}

function assertOpenAICompletionsPayloadHasConversationTurn(
  params: Record<string, unknown>,
  model: Model,
): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || hasOpenAICompatibleConversationTurn(messages)) {
    return;
  }
  throw new Error(
    `OpenAI-compatible chat payload for ${model.provider}/${model.id} contains no non-empty user or assistant messages after compaction and transport transforms; refusing to send a system/tool-only request. Start a new user turn or repair the compacted session history.`,
  );
}

const SSE_DONE_LINE_RE = /^data:[ \t]*\[DONE\][ \t]*$/i;
const SSE_DONE_MAX_LINE_CHARS = 1_024;

function createSseDoneDetector() {
  const decoder = new TextDecoder();
  let line = "";
  let lineOverflowed = false;
  let sawDone = false;

  const finishLine = () => {
    if (!lineOverflowed && SSE_DONE_LINE_RE.test(line)) {
      sawDone = true;
    }
    line = "";
    lineOverflowed = false;
  };
  const observeText = (text: string) => {
    for (const char of text) {
      if (char === "\n" || char === "\r") {
        finishLine();
        continue;
      }
      if (!lineOverflowed && line.length < SSE_DONE_MAX_LINE_CHARS) {
        line += char;
      } else {
        // Never let truncation turn a suffix of a large data line into a
        // standalone terminal marker.
        lineOverflowed = true;
      }
    }
  };

  return {
    observe(chunk: Uint8Array) {
      if (!sawDone) {
        observeText(decoder.decode(chunk, { stream: true }));
      }
    },
    finish() {
      if (sawDone) {
        return;
      }
      observeText(decoder.decode());
      if (line || lineOverflowed) {
        finishLine();
      }
    },
    sawDone: () => sawDone,
  };
}

function createOpenAICompletionsClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  opts?: { fetch?: typeof globalThis.fetch },
) {
  const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
  return new OpenAI({
    apiKey,
    baseURL: clientConfig.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: clientConfig.defaultHeaders,
    defaultQuery: clientConfig.defaultQuery,
    fetch: opts?.fetch ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}

function isKnownOpenAICompletionsEndpoint(model: Pick<Model, "baseUrl">): boolean {
  if (!model.baseUrl.trim()) {
    return true;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  if (endpointClass === "openai-public" || endpointClass === "azure-openai") {
    return true;
  }
  try {
    return isAzureOpenAICompatibleHost(new URL(model.baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildOpenAICompletionsClientConfig(
  model: Model,
  context: Context,
  optionHeaders?: Record<string, string>,
): {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  defaultQuery?: Record<string, string>;
} {
  const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
  const defaultQuery: Record<string, string> = {};
  let baseURL = model.baseUrl;
  let isAzureHost = false;

  try {
    const parsed = new URL(model.baseUrl);
    isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
    parsed.searchParams.forEach((value, key) => {
      if (value) {
        defaultQuery[key] = value;
      }
    });
    parsed.search = "";
    baseURL = parsed.toString().replace(/\/$/, "");
  } catch {
    // Keep the configured base URL unchanged; the OpenAI SDK will surface invalid URLs.
  }

  if (isAzureHost) {
    const apiVersionHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === "api-version",
    );
    if (apiVersionHeader) {
      const apiVersion = headers[apiVersionHeader]?.trim();
      delete headers[apiVersionHeader];
      if (apiVersion && !defaultQuery["api-version"]) {
        defaultQuery["api-version"] = apiVersion;
      }
    }
  }

  return {
    baseURL,
    defaultHeaders: headers,
    defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : undefined,
  };
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
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
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        // The OpenAI SDK consumes the SSE terminal without yielding it. Observe
        // the raw body so native tool calls can distinguish clean DONE from EOF.
        const doneDetector = createSseDoneDetector();
        const baseFetch = buildGuardedModelFetch(model);
        const doneDetectingFetch: typeof globalThis.fetch = async (url, init) => {
          const response = await baseFetch(url as never, init);
          if (!response.body || !response.ok) {
            return response;
          }
          if (typeof TransformStream === "undefined" || !response.body.pipeThrough) {
            return response;
          }
          const transformed = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                doneDetector.observe(chunk);
                controller.enqueue(chunk);
              },
              flush() {
                doneDetector.finish();
              },
            }),
          );
          return new Response(transformed, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          });
        };
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers, {
          fetch: doneDetectingFetch,
        });
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const compat = getCompat(model as OpenAIModeModel);
        if (compat.requiresNonEmptyUserOrAssistantMessage) {
          assertOpenAICompletionsPayloadHasConversationTurn(params, model);
        }
        const emitReasoning = shouldEmitOpenAICompletionsReasoning(
          model as OpenAIModeModel,
          options as OpenAICompletionsOptions | undefined,
        );
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const responseStream = (await client.chat.completions.create(
          params as never,
          buildOpenAISdkRequestOptions(model, firstEventAbort.signal),
        )) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ type: "start", partial: output as never });
        await processOpenAICompletionsStream(responseStream, output, model, stream, {
          signal: options?.signal,
          emitReasoning,
          firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
          sawStreamDONE: doneDetector.sawDone,
        });
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model,
  stream: { push(event: unknown): void },
  options?: {
    signal?: AbortSignal;
    emitReasoning?: boolean;
    firstEventTimeoutMs?: number;
    abortFirstEventStream?: (reason: Error) => void;
    onFirstEventTimeout?: (reason: Error) => void;
    sawStreamDONE?: () => boolean;
  },
) {
  const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256_000;
  const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256_000;
  const emitReasoning = options?.emitReasoning ?? true;
  const compat = getCompat(model as OpenAIModeModel);
  const deepSeekTextFilter = shouldFilterDeepSeekDsmlText(compat)
    ? createDeepSeekTextFilter()
    : null;
  const deepSeekToolCallRecoverer = shouldFilterDeepSeekDsmlText(compat)
    ? createDeepSeekDsmlToolCallRecoverer()
    : null;
  const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
  type ToolCallBlock = {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    partialArgs: string;
    thoughtSignature?: string;
  };
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | ToolCallBlock
    | null = null;
  let pendingPostToolCallDeltas: CompletionsReasoningDelta[] = [];
  let pendingPostToolCallBytes = 0;
  let isFlushingPendingPostToolCallDeltas = false;
  const toolCallBlocksByIndex = new Map<number, ToolCallBlock>();
  const toolCallBlocksById = new Map<string, ToolCallBlock>();
  const provisionalCommentaryTags: PendingCommentaryTags = new Map();
  const toolCallBlockBytes = new WeakMap<ToolCallBlock, number>();
  const toolCallBlockIndices = new WeakMap<ToolCallBlock, number>();
  let sawStopFinishReason = false;
  let sawNativeToolCallDelta = false;
  const blockIndex = () => output.content.length - 1;
  const measureUtf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
  let chunkPushedEvent = false;
  const pushStreamEvent = (event: unknown) => {
    chunkPushedEvent = true;
    stream.push(event);
  };
  const queuePostToolCallDelta = (next: CompletionsReasoningDelta) => {
    const nextBytes = measureUtf8Bytes(next.text);
    if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) {
      throw new Error("Exceeded post-tool-call delta buffer limit");
    }
    pendingPostToolCallBytes += nextBytes;
    const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
    if (!previous || previous.kind !== next.kind) {
      pendingPostToolCallDeltas.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        pendingPostToolCallDeltas.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const appendThinkingDeltaInternal = (reasoningDelta: { signature: string; text: string }) => {
    if (!currentBlock || currentBlock.type !== "thinking") {
      currentBlock = {
        type: "thinking",
        thinking: "",
        ...(reasoningDelta.signature ? { thinkingSignature: reasoningDelta.signature } : {}),
      };
      output.content.push(currentBlock);
      pushStreamEvent({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.thinking += reasoningDelta.text;
    pushStreamEvent({
      type: "thinking_delta",
      contentIndex: blockIndex(),
      delta: reasoningDelta.text,
      partial: output,
    });
  };
  const appendTextDeltaInternal = (text: string) => {
    if (!currentBlock || currentBlock.type !== "text") {
      currentBlock = { type: "text", text: "" };
      output.content.push(currentBlock);
      pushStreamEvent({ type: "text_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.text += text;
    pushStreamEvent({
      type: "text_delta",
      contentIndex: blockIndex(),
      delta: text,
    });
  };
  const flushPendingPostToolCallDeltas = () => {
    if (
      isFlushingPendingPostToolCallDeltas ||
      currentBlock?.type === "toolCall" ||
      pendingPostToolCallDeltas.length === 0
    ) {
      return;
    }
    isFlushingPendingPostToolCallDeltas = true;
    const bufferedDeltas = pendingPostToolCallDeltas;
    pendingPostToolCallDeltas = [];
    pendingPostToolCallBytes = 0;
    for (const delta of bufferedDeltas) {
      if (delta.kind === "text") {
        appendTextDeltaInternal(delta.text);
      } else if (emitReasoning) {
        appendThinkingDeltaInternal(delta);
      }
    }
    isFlushingPendingPostToolCallDeltas = false;
  };
  const appendThinkingDelta = (reasoningDelta: { signature: string; text: string }) => {
    flushPendingPostToolCallDeltas();
    appendThinkingDeltaInternal(reasoningDelta);
  };
  const appendTextDelta = (text: string) => {
    flushPendingPostToolCallDeltas();
    appendTextDeltaInternal(text);
  };
  const appendVisibleTextDelta = (text: string) => {
    if (!text) {
      return;
    }
    if (currentBlock?.type === "toolCall") {
      queuePostToolCallDelta({ kind: "text", text });
    } else {
      appendTextDelta(text);
    }
  };
  const appendRecoveredToolCall = (toolCall: RecoveredDeepSeekDsmlToolCall) => {
    const switchingToolCall = currentBlock?.type === "toolCall";
    if (switchingToolCall) {
      currentBlock = null;
      flushPendingPostToolCallDeltas();
    }
    rememberPendingCommentaryTags(
      provisionalCommentaryTags,
      tagPendingCommentaryText(output.content),
    );
    const block: ToolCallBlock = {
      type: "toolCall",
      // DSML has no provider call id. A response-local counter would alias a
      // later assistant response and could collapse distinct mutating calls.
      id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: toolCall.name,
      arguments: toolCall.arguments,
      partialArgs: toolCall.partialArgs,
    };
    currentBlock = block;
    output.content.push(block);
    toolCallBlockIndices.set(block, output.content.length - 1);
    pushStreamEvent({
      type: "toolcall_start",
      contentIndex: toolCallBlockIndices.get(block) ?? -1,
      partial: output,
    });
    pushStreamEvent({
      type: "toolcall_delta",
      contentIndex: toolCallBlockIndices.get(block) ?? -1,
      delta: toolCall.partialArgs,
      partial: output,
    });
  };
  const appendFilteredVisibleTextDelta = (text: string) => {
    const recoveredParts = deepSeekToolCallRecoverer?.push(text) ?? [
      { kind: "text" as const, text },
    ];
    for (const recoveredPart of recoveredParts) {
      if (recoveredPart.kind === "toolCall") {
        appendRecoveredToolCall(recoveredPart);
        continue;
      }
      const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
      for (const part of parts) {
        appendVisibleTextDelta(part);
      }
    }
  };
  const flushDeepSeekToolCallRecovererAtEnd = () => {
    const recoveredParts = deepSeekToolCallRecoverer?.flush();
    if (!recoveredParts) {
      return;
    }
    for (const recoveredPart of recoveredParts) {
      if (recoveredPart.kind === "toolCall") {
        appendRecoveredToolCall(recoveredPart);
        continue;
      }
      const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
      for (const part of parts) {
        appendVisibleTextDelta(part);
      }
    }
  };
  const flushDeepSeekTextFilterAtEnd = () => {
    const parts = deepSeekTextFilter?.flush();
    if (!parts) {
      return;
    }
    for (const part of parts) {
      appendVisibleTextDelta(part);
    }
  };
  const appendRoutedContentDelta = (delta: CompletionsReasoningDelta) => {
    if (delta.kind === "text") {
      appendFilteredVisibleTextDelta(delta.text);
      return;
    }
    if (!emitReasoning) {
      return;
    }
    if (currentBlock?.type === "toolCall") {
      queuePostToolCallDelta(delta);
    } else {
      appendThinkingDelta(delta);
    }
  };
  const appendPartitionedVisibleDelta = (delta: { kind: "text" | "thinking"; text: string }) => {
    if (delta.kind === "text") {
      appendFilteredVisibleTextDelta(delta.text);
    }
  };
  const emitReasoningUsageActivity = (hasReasoningUsageActivity: boolean) => {
    if (!hasReasoningUsageActivity || chunkPushedEvent || !emitReasoning) {
      return;
    }
    const latestBlock = output.content[output.content.length - 1];
    if (currentBlock?.type === "text" || currentBlock?.type === "toolCall") {
      return;
    }
    if (latestBlock?.type === "text" || latestBlock?.type === "toolCall") {
      return;
    }
    appendThinkingDelta({ signature: "", text: "" });
  };
  const flushReasoningTagTextPartitionerAtEnd = () => {
    for (const delta of reasoningTagTextPartitioner.flush()) {
      appendPartitionedVisibleDelta(delta);
    }
  };
  const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
  const guardedStream = withFirstStreamEventTimeout(responseStream as AsyncIterable<unknown>, {
    provider: model.provider,
    api: model.api,
    model: model.id,
    timeoutMs: options?.firstEventTimeoutMs ?? 0,
    stage: "completions",
    abort: options?.abortFirstEventStream,
    onTimeout: options?.onFirstEventTimeout,
    hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
  });
  for await (const rawChunk of guardedStream) {
    throwIfModelStreamAborted(options?.signal);
    chunkPushedEvent = false;
    if (!rawChunk || typeof rawChunk !== "object") {
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const chunk = rawChunk as ChatCompletionChunk;
    output.responseId ||= chunk.id;
    let hasReasoningUsageActivity = false;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(chunk.usage);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(choiceUsage);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapOpenAIStopReason(choice.finish_reason, {
        allowSingularToolCall: true,
      });
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.stopReason === "stop") {
        sawStopFinishReason = true;
      }
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    const choiceDelta =
      choice.delta ??
      (choice as unknown as { message?: ChatCompletionChunk["choices"][number]["delta"] }).message;
    if (!choiceDelta) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const reasoningDeltas = getCompletionsReasoningDeltas(
      choiceDelta as Record<string, unknown>,
      compat.visibleReasoningDetailTypes,
    );
    const hasMirroredReasoning = reasoningDeltas.some((delta) => delta.kind === "thinking");
    if (hasMirroredReasoning) {
      reasoningTagTextPartitioner.markStrict();
    }
    if (choiceDelta.content) {
      // Structured content can contain visible text and thinking blocks in the
      // same delta, so route each extracted block through the normal stream path.
      const contentDeltas = getCompletionsContentDeltas(choiceDelta.content);
      for (const contentDelta of contentDeltas) {
        if (contentDelta.kind === "text") {
          const routedDeltas = hasMirroredReasoning
            ? reasoningTagTextPartitioner.push(contentDelta.text)
            : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
          for (const routedDelta of routedDeltas) {
            appendPartitionedVisibleDelta(routedDelta);
          }
        } else {
          reasoningTagTextPartitioner.markStrict();
          appendRoutedContentDelta(contentDelta);
        }
      }
    }
    // Chat Completions can put safety/structured-output refusals in a top-level
    // `refusal` field with content null. Surface that as visible text so the
    // assistant turn is not empty (Responses path already routes refusal deltas).
    const refusalText = typeof choiceDelta.refusal === "string" ? choiceDelta.refusal : "";
    if (refusalText) {
      const routedDeltas = hasMirroredReasoning
        ? reasoningTagTextPartitioner.push(refusalText)
        : reasoningTagTextPartitioner.pushVisible(refusalText);
      for (const routedDelta of routedDeltas) {
        appendPartitionedVisibleDelta(routedDelta);
      }
    }
    for (const reasoningDelta of reasoningDeltas) {
      if (reasoningDelta.kind === "thinking" && !emitReasoning) {
        continue;
      }
      if (currentBlock?.type === "toolCall") {
        queuePostToolCallDelta({ ...reasoningDelta });
        continue;
      }
      if (reasoningDelta.kind === "text") {
        appendTextDelta(reasoningDelta.text);
      } else if (emitReasoning) {
        appendThinkingDelta(reasoningDelta);
      }
    }
    if (choiceDelta.tool_calls && choiceDelta.tool_calls.length > 0) {
      sawNativeToolCallDelta = true;
      flushReasoningTagTextPartitionerAtEnd();
      rememberPendingCommentaryTags(
        provisionalCommentaryTags,
        tagPendingCommentaryText(output.content),
      );
      for (const toolCall of choiceDelta.tool_calls) {
        const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
        let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
        if (!block && toolCall.id) {
          block = toolCallBlocksById.get(toolCall.id);
        }
        if (!block) {
          const switchingToolCall = currentBlock?.type === "toolCall";
          if (switchingToolCall) {
            currentBlock = null;
            flushPendingPostToolCallDeltas();
          }
          const initialSig = extractGoogleThoughtSignature(toolCall);
          block = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
            ...(initialSig ? { thoughtSignature: initialSig } : {}),
          };
          output.content.push(block);
          toolCallBlockIndices.set(block, output.content.length - 1);
          pushStreamEvent({
            type: "toolcall_start",
            contentIndex: toolCallBlockIndices.get(block) ?? -1,
            partial: output,
          });
        }
        if (streamIndex !== undefined && !toolCallBlocksByIndex.has(streamIndex)) {
          toolCallBlocksByIndex.set(streamIndex, block);
        }
        if (toolCall.id) {
          block.id = toolCall.id;
          toolCallBlocksById.set(toolCall.id, block);
        }
        currentBlock = block;
        if (toolCall.function?.name) {
          block.name = toolCall.function.name;
        }
        const deltaSig = extractGoogleThoughtSignature(toolCall);
        if (deltaSig) {
          block.thoughtSignature = deltaSig;
        }
        if (toolCall.function?.arguments) {
          const nextArgumentBytes = measureUtf8Bytes(toolCall.function.arguments);
          const currentBlockArgBytes = toolCallBlockBytes.get(block) ?? 0;
          if (currentBlockArgBytes + nextArgumentBytes > MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES) {
            throw new Error("Exceeded tool-call argument buffer limit");
          }
          toolCallBlockBytes.set(block, currentBlockArgBytes + nextArgumentBytes);
          block.partialArgs += toolCall.function.arguments;
          block.arguments = parseStreamingJson(block.partialArgs);
          pushStreamEvent({
            type: "toolcall_delta",
            contentIndex: toolCallBlockIndices.get(block) ?? -1,
            delta: toolCall.function.arguments,
            partial: output,
          });
        }
      }
    }
    flushPendingPostToolCallDeltas();
    emitReasoningUsageActivity(hasReasoningUsageActivity);
    await cooperativeScheduler.afterEvent();
  }
  flushReasoningTagTextPartitionerAtEnd();
  flushDeepSeekToolCallRecovererAtEnd();
  flushDeepSeekTextFilterAtEnd();
  currentBlock = null;
  flushPendingPostToolCallDeltas();
  const hasToolCalls = output.content.some((block) => block.type === "toolCall");
  const hasVisibleText = output.content.some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
  if (output.stopReason === "toolUse" && !hasToolCalls) {
    output.stopReason = "stop";
  }
  // Promote complete silent tool-call-only responses when the stream finished
  // cleanly (reached post-loop). Two paths:
  //   sawStopFinishReason: explicit provider terminal (legacy DSML / #88791)
  //   sawNativeToolCallDelta + sawStreamDONE: structured delta.tool_calls with
  //     a clean SSE [DONE] terminal but no finish_reason (e.g. Evolink
  //     DeepSeek V4). [DONE] tracking distinguishes clean termination from
  //     connection drops (EOF without [DONE] remains fail-closed).
  // Truncated streams throw before reaching this code.
  if (
    output.stopReason === "stop" &&
    hasToolCalls &&
    !hasVisibleText &&
    (sawStopFinishReason || (sawNativeToolCallDelta && (options?.sawStreamDONE?.() ?? false)))
  ) {
    output.stopReason = "toolUse";
  }
  if (hasToolCalls && output.stopReason !== "toolUse") {
    output.content = output.content.filter((block) => block.type !== "toolCall");
  }
  if (output.stopReason !== "toolUse") {
    clearPendingCommentaryText(provisionalCommentaryTags);
  }
  if (output.stopReason === "toolUse") {
    tagPendingCommentaryText(output.content);
  }
}

type CompletionsReasoningDelta =
  | {
      kind: "thinking";
      signature: string;
      text: string;
    }
  | {
      kind: "text";
      text: string;
    };

function shouldFilterDeepSeekDsmlText(compat: ReturnType<typeof getCompat>) {
  return compat.thinkingFormat === "deepseek";
}

type RecoveredDeepSeekDsmlToolCall = {
  kind: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
  partialArgs: string;
};

type DeepSeekDsmlRecoveredPart = { kind: "text"; text: string } | RecoveredDeepSeekDsmlToolCall;

const DEEPSEEK_DSML_BARS = ["|", "｜"] as const;
const DEEPSEEK_DSML_TOOL_KINDS = ["tool_calls", "tool_call", "function_calls"] as const;
const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_BARS.flatMap((bar) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `<${bar}DSML${bar}${kind}>`),
);
const DEEPSEEK_DSML_TOOL_CLOSE_TOKENS = DEEPSEEK_DSML_BARS.flatMap((bar) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `</${bar}DSML${bar}${kind}>`),
);
const DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN = Math.max(
  ...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length),
);

function createDeepSeekDsmlToolCallRecoverer() {
  let buffer = "";

  const consume = (final: boolean): DeepSeekDsmlRecoveredPart[] => {
    const output: DeepSeekDsmlRecoveredPart[] = [];
    while (buffer) {
      const open = findEarliestStringToken(buffer, DEEPSEEK_DSML_TOOL_OPEN_TOKENS);
      if (!open) {
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
          return output;
        }
        const keep = longestDeepSeekDsmlToolOpenPrefixSuffixLength(buffer);
        const emitLength = buffer.length - keep;
        if (emitLength > 0) {
          output.push({ kind: "text", text: buffer.slice(0, emitLength) });
          buffer = buffer.slice(emitLength);
        }
        return output;
      }

      if (open.index > 0) {
        output.push({ kind: "text", text: buffer.slice(0, open.index) });
        buffer = buffer.slice(open.index);
      }

      const afterOpen = buffer.slice(open.token.length);
      const close = findEarliestStringToken(afterOpen, DEEPSEEK_DSML_TOOL_CLOSE_TOKENS);
      if (!close) {
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
        }
        return output;
      }

      const body = afterOpen.slice(0, close.index);
      const blockLength = open.token.length + close.index + close.token.length;
      const recoveredToolCalls = parseDeepSeekDsmlToolCallBlock(body);
      if (recoveredToolCalls.length > 0) {
        output.push(...recoveredToolCalls);
      } else {
        output.push({ kind: "text", text: buffer.slice(0, blockLength) });
      }
      buffer = buffer.slice(blockLength);
    }
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}

function parseDeepSeekDsmlToolCallBlock(body: string): RecoveredDeepSeekDsmlToolCall[] {
  const toolCalls: RecoveredDeepSeekDsmlToolCall[] = [];
  const invokeOpenRegex = /<[|｜]DSML[|｜]invoke\b([^>]*)>/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = invokeOpenRegex.exec(body)) !== null) {
    const invokeName = parseXmlAttribute(openMatch[1] ?? "", "name");
    if (!invokeName) {
      continue;
    }
    const invokeBodyStart = openMatch.index + openMatch[0].length;
    const invokeClose = findEarliestStringToken(body.slice(invokeBodyStart), [
      "</|DSML|invoke>",
      "</｜DSML｜invoke>",
    ]);
    if (!invokeClose) {
      continue;
    }
    const invokeBody = body.slice(invokeBodyStart, invokeBodyStart + invokeClose.index);
    invokeOpenRegex.lastIndex = invokeBodyStart + invokeClose.index + invokeClose.token.length;
    const parsedArguments = parseDeepSeekDsmlInvokeArguments(invokeBody);
    if (!parsedArguments) {
      continue;
    }
    toolCalls.push({
      kind: "toolCall",
      name: invokeName,
      arguments: parsedArguments,
      partialArgs: JSON.stringify(parsedArguments),
    });
  }
  return toolCalls;
}

function parseDeepSeekDsmlInvokeArguments(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const parameterRegex = /<[|｜]DSML[|｜]parameter\b([^>]*)>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/g;
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterRegex.exec(body)) !== null) {
    const name = parseXmlAttribute(parameterMatch[1] ?? "", "name");
    if (!name) {
      continue;
    }
    const rawValue = parameterMatch[2] ?? "";
    if (rawValue.length === 0) {
      continue;
    }
    args[name] = decodeDeepSeekDsmlText(rawValue);
  }
  if (Object.keys(args).length > 0) {
    return args;
  }

  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && Object.keys(parsed).length > 0) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

// Cache compiled attribute matchers by name so the streaming parser does not
// recompile a RegExp on every chunk/parameter it scans.
const xmlAttributeRegexCache = new Map<string, RegExp>();

function xmlAttributeRegex(name: string): RegExp {
  const cached = xmlAttributeRegexCache.get(name);
  if (cached) {
    return cached;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)'|([^\\s>]+))`);
  xmlAttributeRegexCache.set(name, pattern);
  return pattern;
}

function parseXmlAttribute(attributes: string, name: string): string | null {
  const match = xmlAttributeRegex(name).exec(attributes);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value ? decodeDeepSeekDsmlText(value) : null;
}

function decodeDeepSeekDsmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function findEarliestStringToken(text: string, tokens: readonly string[]) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function longestDeepSeekDsmlToolOpenPrefixSuffixLength(text: string) {
  const maxLength = Math.min(text.length, DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (DEEPSEEK_DSML_TOOL_OPEN_TOKENS.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}

function getCompletionsContentDeltas(content: unknown): CompletionsReasoningDelta[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.flatMap((item) => getCompletionsContentDeltas(item));
  }
  if (!content || typeof content !== "object") {
    return [];
  }
  const record = content as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  // Some OpenAI-compatible providers, notably Mistral thinking models, stream
  // `delta.content` as typed objects. Never coerce those objects directly or
  // they become persisted visible text like "[object Object]".
  const extractText = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => extractText(item)).join("");
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      return extractText(nested.text ?? nested.content ?? nested.thinking);
    }
    return "";
  };
  const text = extractText(record.text ?? record.content ?? record.thinking);
  if (!text) {
    return [];
  }
  // Preserve provider reasoning as OpenClaw thinking blocks so channel/UI
  // surfaces can decide whether to show it instead of leaking it as answer text.
  if (type.includes("thinking") || type.includes("reasoning")) {
    return [{ kind: "thinking", signature: "content", text }];
  }
  if (type === "text" || type === "output_text" || type.endsWith(".output_text")) {
    return [{ kind: "text", text }];
  }
  return [];
}

function getCompletionsReasoningDeltas(
  delta: Record<string, unknown>,
  visibleReasoningDetailTypes: readonly string[],
): CompletionsReasoningDelta[] {
  const output: CompletionsReasoningDelta[] = [];
  const pushDelta = (next: CompletionsReasoningDelta) => {
    const previous = output[output.length - 1];
    if (!previous || previous.kind !== next.kind) {
      output.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        output.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const reasoningDetails = delta.reasoning_details;
  let usedReasoningThinkingDetails = false;
  if (Array.isArray(reasoningDetails)) {
    const visibleTypes = new Set(visibleReasoningDetailTypes);
    for (const item of reasoningDetails) {
      const detail = item as { type?: unknown; text?: unknown };
      if (typeof detail.text !== "string" || !detail.text) {
        continue;
      }
      if (detail.type === "reasoning.text") {
        usedReasoningThinkingDetails = true;
        pushDelta({ kind: "thinking", signature: "reasoning_details", text: detail.text });
        continue;
      }
      if (typeof detail.type === "string" && visibleTypes.has(detail.type)) {
        pushDelta({ kind: "text", text: detail.text });
      }
    }
  }
  if (!usedReasoningThinkingDetails) {
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    for (const field of reasoningFields) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        pushDelta({ kind: "thinking", signature: field, text: value });
        break;
      }
    }
  }
  return output;
}

function resolveOpenAICompletionsReasoningEffort(options: OpenAICompletionsOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

function shouldEmitOpenAICompletionsReasoning(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  if (!model.reasoning) {
    return false;
  }
  const effort = resolveOpenAICompletionsReasoningEffort(options);
  if (!effort || !isOpenAICompletionsThinkingEnabled(effort)) {
    return false;
  }
  return true;
}

function shouldEmitOpenAICompletionsReasoningForModel(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  return shouldEmitOpenAICompletionsReasoning(model, options);
}

function resolveOpenAICompletionsMaxTokens(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
): { maxTokens: number | undefined; clampToModelMaxTokens: boolean } {
  if (options?.maxTokens) {
    return { maxTokens: options.maxTokens, clampToModelMaxTokens: true };
  }
  const paramsMaxTokens = resolveMaxTokensParam(
    (model as { params?: Record<string, unknown> }).params,
  );
  if (paramsMaxTokens) {
    return { maxTokens: paramsMaxTokens, clampToModelMaxTokens: false };
  }
  return { maxTokens: model.maxTokens, clampToModelMaxTokens: false };
}

function resolveOpenAICompletionsModelMaxTokens(model: OpenAIModeModel): number | undefined {
  return typeof model.maxTokens === "number" &&
    Number.isFinite(model.maxTokens) &&
    model.maxTokens > 0
    ? Math.floor(model.maxTokens)
    : undefined;
}

const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8_000;

// Used only to bound `max_completion_tokens` below the effective context cap
// for strict OpenAI-compatible servers (e.g. vLLM, StepFun). The CJK-aware
// helper avoids undercounting non-Latin prompts enough to trigger server-side
// context rejections; wrong-high here just trims output a little. Estimate the
// final shaped payload, not the raw context, so compat transforms and dropped
// replay turns are reflected in the output cap.
function estimateOpenAICompletionsInputTokens(payload: {
  messages?: unknown;
  tools?: unknown;
  response_format?: unknown;
}): number {
  let adjustedChars = 0;
  adjustedChars += estimateOpenAICompletionsMessagesChars(payload.messages);
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.tools));
    } catch {
      adjustedChars += 1024;
    }
  }
  if (payload.response_format !== undefined) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.response_format));
    } catch {
      adjustedChars += 256;
    }
  }
  return Math.ceil(
    (adjustedChars / CHARS_PER_TOKEN_ESTIMATE) * OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN,
  );
}

function estimateOpenAICompletionsMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    adjustedChars += estimateOpenAICompletionsContentChars(record.content);
    for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
      adjustedChars += estimateOpenAICompletionsContentChars(record[field]);
    }
    if (record.tool_calls !== undefined) {
      try {
        adjustedChars += estimateStringChars(JSON.stringify(record.tool_calls));
      } catch {
        adjustedChars += 256;
      }
    }
  }
  return adjustedChars;
}

function estimateOpenAICompletionsContentChars(value: unknown): number {
  if (typeof value === "string") {
    return estimateStringChars(value);
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image_url" || record.type === "input_image") {
      adjustedChars += OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE;
      continue;
    }
    const text = record.text;
    if (typeof text === "string") {
      adjustedChars += estimateStringChars(text);
      continue;
    }
    try {
      adjustedChars += estimateStringChars(JSON.stringify(block));
    } catch {
      adjustedChars += 256;
    }
  }
  return adjustedChars;
}

function resolveOpenAICompletionsEffectiveContextTokens(
  model: OpenAIModeModel,
): number | undefined {
  const contextTokens = (model as { contextTokens?: number }).contextTokens;
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
    return contextTokens;
  }
  return typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
    ? model.contextWindow
    : undefined;
}

function isQwenOpenAICompletionsThinkingFormat(format: string): boolean {
  return format === "qwen" || format === "qwen-chat-template";
}

function isOpenAICompletionsThinkingEnabled(effort: OpenAIReasoningEffort): boolean {
  const normalized = effort.trim().toLowerCase();
  return normalized !== "off" && normalized !== "none";
}

function setQwenChatTemplateThinking(params: Record<string, unknown>, enabled: boolean): void {
  const existing = params.chat_template_kwargs;
  params.chat_template_kwargs =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), enable_thinking: enabled }
      : { enable_thinking: enabled };
}

function applyQwenOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): boolean {
  if (
    !params.modelReasoning ||
    !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)
  ) {
    return false;
  }
  const enabled = isOpenAICompletionsThinkingEnabled(params.requestedEffort);
  if (params.compatThinkingFormat === "qwen-chat-template") {
    setQwenChatTemplateThinking(params.payload, enabled);
  } else {
    params.payload.enable_thinking = enabled;
  }
  return true;
}

function applyTogetherOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): boolean {
  if (!params.modelReasoning || params.compatThinkingFormat !== "together") {
    return false;
  }
  params.payload.reasoning = {
    enabled: isOpenAICompletionsThinkingEnabled(params.requestedEffort),
  };
  return true;
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(
    projection,
    resolveOpenAIStrictToolSetting(model, {
      transport: "stream",
      supportsStrictMode: compat?.supportsStrictMode,
    }),
    {
      transport: "completions",
      model,
    },
  );
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool) => {
      const functionTool: {
        name: string;
        description: string | undefined;
        parameters: ReturnType<typeof normalizeOpenAIStrictToolParameters>;
        strict?: boolean;
      } = {
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      };
      if (strict !== undefined) {
        functionTool.strict = strict;
      }
      return {
        type: "function",
        function: functionTool,
      };
    }),
  };
}

function extractGoogleThoughtSignature(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | undefined;
  if (!tc) {
    return undefined;
  }
  const extra = (tc.extra_content as Record<string, unknown> | undefined)?.google as
    | Record<string, unknown>
    | undefined;
  const fromExtra = extra?.thought_signature;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    return fromExtra;
  }
  const fromFunction = (tc.function as { thought_signature?: unknown } | undefined)
    ?.thought_signature;
  return typeof fromFunction === "string" && fromFunction.length > 0 ? fromFunction : undefined;
}

function isGoogleOpenAICompatModel(model: OpenAIModeModel): boolean {
  const endpointClass = detectOpenAICompletionsCompat(model as Model<"openai-completions">)
    .capabilities.endpointClass;
  return (
    model.provider === "google" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex"
  );
}

function requiresGoogleCompatToolCallThoughtSignature(model: OpenAIModeModel): boolean {
  return isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id);
}

const GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function hasGoogleCompatThoughtSignatureTruncationFootprint(value: string): boolean {
  return (
    GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) ||
    (GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0)
  );
}

function injectToolCallThoughtSignatures(
  outgoingMessages: unknown[],
  context: Context,
  model: OpenAIModeModel,
): void {
  if (!isGoogleOpenAICompatModel(model)) {
    return;
  }
  const sigById = new Map<string, string>();
  const fallbackSig = requiresGoogleCompatToolCallThoughtSignature(model)
    ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
    : undefined;
  for (const msg of context.messages ?? []) {
    if ((msg as { role?: string }).role !== "assistant") {
      continue;
    }
    const source = msg as { api?: string; provider?: string; model?: string; content?: unknown };
    if (!Array.isArray(source.content)) {
      continue;
    }
    for (const block of source.content as Array<Record<string, unknown>>) {
      if (block.type !== "toolCall") {
        continue;
      }
      const id = block.id;
      const sig = block.thoughtSignature;
      if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
        const isSameRoute =
          source.api === model.api &&
          source.provider === model.provider &&
          source.model === model.id;
        if (!isSameRoute && !fallbackSig) {
          continue;
        }
        sigById.set(id, isSameRoute ? sig : (fallbackSig ?? sig));
      }
    }
  }
  if (sigById.size === 0 && !fallbackSig) {
    return;
  }
  for (const message of outgoingMessages) {
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
      const id = toolCall.id;
      if (typeof id !== "string") {
        continue;
      }
      let sig: string | undefined = sigById.get(id) ?? fallbackSig;
      if (typeof sig === "string" && sig.length > 0) {
        const trimmed = sig.trim();
        if (hasGoogleCompatThoughtSignatureTruncationFootprint(trimmed)) {
          sig = fallbackSig;
        }
      }
      if (typeof sig !== "string" || sig.length === 0) {
        continue;
      }
      const extra =
        toolCall.extra_content && typeof toolCall.extra_content === "object"
          ? (toolCall.extra_content as Record<string, unknown>)
          : {};
      toolCall.extra_content = extra;
      const google =
        extra.google && typeof extra.google === "object"
          ? (extra.google as Record<string, unknown>)
          : {};
      extra.google = google;
      google.thought_signature = sig;
    }
  }
}

const COMPLETIONS_REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

function stripCompletionsReasoningReplayFields(record: Record<string, unknown>): void {
  for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
    if (field in record) {
      delete record[field];
    }
  }
}

function sanitizeOpenRouterReasoningReplayFields(record: Record<string, unknown>): void {
  const reasoningDetails = record.reasoning_details;
  if (typeof reasoningDetails === "string") {
    if (reasoningDetails.length > 0 && typeof record.reasoning !== "string") {
      record.reasoning = reasoningDetails;
    }
    delete record.reasoning_details;
  } else if (reasoningDetails !== undefined && !Array.isArray(reasoningDetails)) {
    delete record.reasoning_details;
  }

  // Empty reasoning artifacts are rejected by OpenRouter/DeepSeek replay.
  if ("reasoning" in record && (typeof record.reasoning !== "string" || record.reasoning === "")) {
    delete record.reasoning;
  }
  if (
    "reasoning_content" in record &&
    (typeof record.reasoning_content !== "string" || record.reasoning_content === "")
  ) {
    delete record.reasoning_content;
  }

  const reasoningText = record.reasoning_text;
  if (
    typeof reasoningText === "string" &&
    reasoningText.length > 0 &&
    typeof record.reasoning !== "string" &&
    typeof record.reasoning_content !== "string"
  ) {
    record.reasoning = reasoningText;
  }
  if ("reasoning_text" in record) {
    delete record.reasoning_text;
  }
}

function sanitizeReasoningContentReplayFields(record: Record<string, unknown>): void {
  if ("reasoning_content" in record && typeof record.reasoning_content !== "string") {
    delete record.reasoning_content;
  }
  delete record.reasoning_details;
  delete record.reasoning;
  delete record.reasoning_text;
}

const REASONING_CONTENT_REPLAY_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-for-coding",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
]);

// Tier/access suffixes that some providers append to otherwise identical model
// ids (OpenCode Zen exposes `deepseek-v4-flash-free`, OpenRouter exposes
// `:free` / `:cloud`, etc.). The base model id before the suffix still owns
// the same DeepSeek-style reasoning_content replay contract, so reasoning
// replay must not be stripped just because the catalog id grew a marketing
// suffix (#87575).
const REASONING_CONTENT_REPLAY_TIER_SUFFIXES = ["-free", "-paid", "-trial"] as const;

function stripReasoningContentReplayTierSuffix(modelId: string): string {
  for (const suffix of REASONING_CONTENT_REPLAY_TIER_SUFFIXES) {
    if (modelId.length > suffix.length && modelId.endsWith(suffix)) {
      return modelId.slice(0, -suffix.length);
    }
  }
  return modelId;
}

function getReasoningContentReplayModelIdCandidates(modelId: unknown): string[] {
  if (typeof modelId !== "string") {
    return [];
  }
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const parts = normalized.split("/").filter(Boolean);
  const finalPart = parts[parts.length - 1] ?? normalized;
  const candidates = [finalPart];
  const colonParts = finalPart.split(":").filter(Boolean);
  if (colonParts.length > 1) {
    candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
  }
  const baseCount = candidates.length;
  for (let index = 0; index < baseCount; index += 1) {
    const candidate = candidates[index];
    if (typeof candidate !== "string") {
      continue;
    }
    const stripped = stripReasoningContentReplayTierSuffix(candidate);
    if (stripped !== candidate) {
      candidates.push(stripped);
    }
  }
  return uniqueStrings(candidates.filter(Boolean));
}

function shouldPreserveReasoningContentReplay(
  model: OpenAIModeModel,
  compat: { requiresReasoningContentOnAssistantMessages: boolean; thinkingFormat: string },
): boolean {
  if (
    compat.requiresReasoningContentOnAssistantMessages ||
    compat.thinkingFormat === "deepseek" ||
    compat.thinkingFormat === "zai" ||
    shouldTrustReasoningContentReplayMetadata(model)
  ) {
    return true;
  }
  return getReasoningContentReplayModelIdCandidates(model.id).some((modelId) =>
    REASONING_CONTENT_REPLAY_MODEL_IDS.has(modelId),
  );
}

function shouldPreserveOpenRouterReasoningReplay(model: OpenAIModeModel): boolean {
  if (model.provider !== "openrouter") {
    return true;
  }
  const normalizedModelId = model.id.trim().toLowerCase();
  return !(normalizedModelId.startsWith("anthropic/") || normalizedModelId.startsWith("x-ai/"));
}

function shouldTrustReasoningContentReplayMetadata(model: OpenAIModeModel): boolean {
  if (!model.reasoning) {
    return false;
  }
  const provider = model.provider.trim().toLowerCase();
  if (provider === "openai") {
    return false;
  }
  return shouldPreserveOpenRouterReasoningReplay(model);
}

// OpenAI Chat Completions assistant-message input does not define reasoning
// replay fields, while OpenRouter and DeepSeek-style providers document
// compatible pass-back contracts. Keep valid provider-owned replay fields, but
// strip them for stock OpenAI before a follow-up request hits the wire.
function sanitizeCompletionsReasoningReplayFields(
  messages: unknown,
  options: { preserveOpenRouterReasoning: boolean; preserveReasoningContent: boolean },
): void {
  if (!Array.isArray(messages)) {
    return;
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (options.preserveOpenRouterReasoning) {
      sanitizeOpenRouterReasoningReplayFields(record);
    } else if (options.preserveReasoningContent) {
      sanitizeReasoningContentReplayFields(record);
    } else {
      stripCompletionsReasoningReplayFields(record);
    }
  }
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const compatDetection = detectOpenAICompletionsCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  let messages = convertMessages(model as never, completionsContext, compat as never);
  injectToolCallThoughtSignatures(messages as unknown[], context, model);
  sanitizeCompletionsReasoningReplayFields(messages, {
    preserveOpenRouterReasoning:
      compat.thinkingFormat === "openrouter" && shouldPreserveOpenRouterReasoningReplay(model),
    preserveReasoningContent: shouldPreserveReasoningContentReplay(model, compat),
  });
  if (compat.strictMessageKeys) {
    messages = stripCompletionMessagesToRoleContent(messages) as typeof messages;
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (compat.supportsPromptCacheKey && promptCacheKey) {
    params.prompt_cache_key = promptCacheKey;
    // When the caller explicitly opted into long retention, forward the
    // canonical prompt_cache_retention value alongside the cache key so
    // OpenAI-compatible completions backends (oMLX, llama.cpp, official
    // OpenAI, etc.) can honor the 24h prefix-cache lifetime. Without this
    // the key reaches the wire but the retention preference is silently dropped.
    if (cacheRetention === "long" && compat.supportsLongCacheRetention) {
      params.prompt_cache_retention = "24h";
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    params.response_format = options.responseFormat;
  }
  if (options?.frequencyPenalty !== undefined) {
    params.frequency_penalty = options.frequencyPenalty;
  }
  if (options?.presencePenalty !== undefined) {
    params.presence_penalty = options.presencePenalty;
  }
  if (options?.seed !== undefined) {
    params.seed = options.seed;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop = options.stop;
  }
  if (supportsModelTools(model)) {
    if (context.tools) {
      const converted = convertTools(context.tools, compat, model);
      if (
        converted.tools.length > 0 ||
        (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
      ) {
        params.tools = converted.tools;
      } else if (hasToolHistory(context.messages)) {
        params.tools = [];
      }
      if (options?.toolChoice) {
        const toolChoice = reconcileOpenAICompletionsToolChoice(
          options.toolChoice,
          converted.projection,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else if (
        compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
        Array.isArray(params.tools) &&
        params.tools.length > 0
      ) {
        params.tool_choice = "auto";
      }
    } else if (hasToolHistory(context.messages)) {
      params.tools = [];
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      Array.isArray(params.tools) &&
      params.tools.length === 0
    ) {
      delete params.tools;
      delete params.tool_choice;
    }
  }
  {
    const maxTokenBudget = resolveOpenAICompletionsMaxTokens(model, options);
    const effectiveMaxTokens = maxTokenBudget.maxTokens;
    const effectiveContextTokens = resolveOpenAICompletionsEffectiveContextTokens(model);
    let clampedMaxTokens = effectiveMaxTokens;
    const modelMaxTokens = resolveOpenAICompletionsModelMaxTokens(model);
    if (
      maxTokenBudget.clampToModelMaxTokens &&
      clampedMaxTokens !== undefined &&
      modelMaxTokens !== undefined &&
      clampedMaxTokens > modelMaxTokens
    ) {
      clampedMaxTokens = modelMaxTokens;
      emitModelTransportDebug(
        log,
        `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
          `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
          `modelMaxTokens=${modelMaxTokens}`,
      );
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      clampedMaxTokens !== undefined &&
      effectiveContextTokens !== undefined
    ) {
      const estimatedInputTokens = estimateOpenAICompletionsInputTokens(params);
      const remainingBudget = Math.max(1, effectiveContextTokens - estimatedInputTokens - 1);
      if (clampedMaxTokens > remainingBudget) {
        clampedMaxTokens = remainingBudget;
        emitModelTransportDebug(
          log,
          `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
            `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
            `effectiveContext=${effectiveContextTokens} estimatedInput=${estimatedInputTokens}`,
        );
      }
    }
    if (clampedMaxTokens) {
      if (compat.maxTokensField === "max_tokens") {
        params.max_tokens = clampedMaxTokens;
      } else {
        params.max_completion_tokens = clampedMaxTokens;
      }
    }
  }
  const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
  const resolvedCompletionsReasoningEffort = completionsReasoningEffort
    ? resolveOpenAIReasoningEffortForModel({
        model,
        effort: completionsReasoningEffort,
        fallbackMap: compat.reasoningEffortMap,
      })
    : undefined;
  const omitChatCompletionsToolReasoningEffort =
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    (isOpenAIGpt54MiniModel(model) ||
      (isOpenAIGpt55Model(model) && isKnownOpenAICompletionsEndpoint(model)));
  const disableChatCompletionsToolReasoning =
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    isOpenAIGpt56Model(model) &&
    isKnownOpenAICompletionsEndpoint(model);
  const handledQwenThinkingFormat = applyQwenOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  applyTogetherOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  if (disableChatCompletionsToolReasoning) {
    // GPT-5.6 Chat Completions defaults reasoning on, but rejects function
    // tools unless reasoning is explicitly disabled.
    params.reasoning_effort = "none";
  } else if (
    compat.thinkingFormat === "openrouter" &&
    model.reasoning &&
    resolvedCompletionsReasoningEffort
  ) {
    params.reasoning = {
      effort: resolvedCompletionsReasoningEffort,
    };
  } else if (
    resolvedCompletionsReasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort &&
    !handledQwenThinkingFormat &&
    !omitChatCompletionsToolReasoningEffort
  ) {
    params.reasoning_effort = resolvedCompletionsReasoningEffort;
  }
  return params;
}

function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]> & {
    cost?: unknown;
    prompt_tokens_details?: { cache_write_tokens?: number | null };
  },
  model: Model,
): MutableAssistantOutput["usage"] {
  // OpenRouter reports cache writes separately inside prompt totals. Keep read/write
  // buckets out of input so normalized prompt buckets stay disjoint.
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  const usage: MutableAssistantOutput["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
      ? { reasoningTokens }
      : {}),
    totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model as never, usage as never);
  applyProviderReportedUsageCost(usage, rawUsage.cost);
  return usage;
}

function hasOpenAICompletionsReasoningUsageActivity(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
) {
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  return (
    typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0
  );
}

const completionsTesting = {
  getCompat,
  createSseDoneDetector,
  createOpenAICompletionsClient,
  buildOpenAICompletionsClientConfig,
  parseTransportChunkUsage,
  processOpenAICompletionsStream,
  shouldEmitOpenAICompletionsReasoningForModel,
};

declare global {
  var openclawOpenAICompletionsTransportTestApi: typeof completionsTesting | undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  globalThis.openclawOpenAICompletionsTransportTestApi = completionsTesting;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
