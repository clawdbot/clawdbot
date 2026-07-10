// Mistral provider adapts Mistral streams and tool calls to the runtime.
import { randomUUID } from "node:crypto";
import { HTTPClient, Mistral, type Fetcher } from "@mistralai/mistralai";
import type {
  ChatCompletionStreamRequest,
  ChatCompletionStreamRequestMessage,
  CompletionEvent,
  ContentChunk,
  FunctionTool,
} from "@mistralai/mistralai/models/components";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { createSseByteGuard } from "../utils/streaming-byte-guard.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { buildBaseOptions } from "./simple-options.js";
import { describeToolResultMediaPlaceholder, extractToolResultText } from "./tool-result-text.js";
import { transformMessages } from "./transform-messages.js";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

// 16 MiB cap on Mistral streaming success bodies, matching the
// `PROVIDER_TEXT_RESPONSE_MAX_BYTES` / `PROVIDER_JSON_RESPONSE_MAX_BYTES`
// 16 MiB cap used elsewhere. A hostile or malfunctioning Mistral-compatible
// endpoint cannot exhaust memory by streaming an unbounded SSE body;
// `createSseByteGuard` cancels the upstream reader and throws once the
// accumulated byte count exceeds this cap.
const MISTRAL_STREAM_BODY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Builds a `Fetcher` that wraps the default `fetch` with a 16 MiB byte cap
 * on streamed response bodies. The wrapped `Response.body` exposes a
 * `ReadableStream` whose chunks flow through `createSseByteGuard`, so the
 * SDK's internal SSE parser (`EventStream` in
 * `@mistralai/mistralai/lib/event-streams.ts`) reads exactly as it would on
 * an unbounded body — but bounded.
 *
 * Bodyless responses (no `body` or no `getReader`) are returned unchanged so
 * the SDK's error-path `res.arrayBuffer()` call still works.
 */
export function createBoundedMistralFetcher(
  maxBytes: number = MISTRAL_STREAM_BODY_MAX_BYTES,
  upstreamFetch: Fetcher = fetch,
): Fetcher {
  return async (input, init) => {
    const response = init == null ? await upstreamFetch(input) : await upstreamFetch(input, init);
    if (!response.body || typeof response.body.getReader !== "function") {
      return response;
    }
    const reader = response.body.getReader();
    const guard = createSseByteGuard(reader, {
      maxBytes,
      onOverflow: ({ size, maxBytes: cap }) =>
        new Error(`mistral: stream body exceeds ${cap} bytes (got ${size})`),
    });
    // Re-shape the response body so the SDK's `responseBody.getReader()`
    // call inside `EventStream` resolves to a stream whose `read()` is
    // routed through `guard.read()`. Cancellation is also forwarded.
    const guardedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await guard.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      async cancel(reason) {
        await guard.cancel(reason);
      },
    });
    return new Response(guardedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Provider-specific options for the Mistral API.
 */
type MistralReasoningEffort = "none" | "high";

interface MistralOptions extends StreamOptions {
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | { type: "function"; function: { name: string } };
  promptMode?: "reasoning";
  reasoningEffort?: MistralReasoningEffort;
}

/**
 * Stream responses from Mistral using `chat.stream`.
 */
export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> = (
  model: Model<"mistral-conversations">,
  context: Context,
  options?: MistralOptions,
) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output = createOutput(model);

    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider);
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      // Intentionally per-request: avoids shared SDK mutable state across concurrent consumers.
      const mistral = new Mistral({
        apiKey,
        serverURL: model.baseUrl,
        // Bound the streamed Mistral response body at 16 MiB so a hostile or
        // malfunctioning endpoint cannot exhaust memory. The fetcher is
        // injected via the SDK's `HTTPClient` (see
        // `@mistralai/mistralai/lib/sdks.ts` `ClientSDK` constructor: when
        // `httpClient` is passed, `ClientSDK.#httpClient` is set from it and
        // every `chat.stream` / `complete` call routes through
        // `HTTPClient.request` → `this.fetcher(req)`).
        // Mistral accepts HTTPClient.fetcher, so compose guarded egress with the byte cap.
        httpClient: new HTTPClient({
          fetcher: createBoundedMistralFetcher(
            MISTRAL_STREAM_BODY_MAX_BYTES,
            getAiTransportHost().buildModelFetch(model) ?? fetch,
          ),
        }),
      });

      const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
      const transformedMessages = transformMessages(context.messages, model, (id) =>
        normalizeMistralToolCallId(id),
      );

      let payload = buildChatPayload(model, context, transformedMessages, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== undefined) {
        payload = nextPayload as ChatCompletionStreamRequest;
      }
      const mistralStream = await mistral.chat.stream(payload, buildRequestOptions(model, options));
      stream.push({ type: "start", partial: output });
      await consumeChatStream(model, output, stream, mistralStream);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        // partialArgs is only a streaming scratch buffer; never persist it.
        delete (block as { partialArgs?: string }).partialArgs;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatMistralError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
  model: Model<"mistral-conversations">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
  const shouldUseReasoning = model.reasoning && reasoning !== undefined;

  return streamMistral(model, context, {
    ...base,
    promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
    reasoningEffort:
      shouldUseReasoning && usesReasoningEffort(model)
        ? mapReasoningEffort(model, reasoning)
        : undefined,
  } satisfies MistralOptions);
};

function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
  return {
    role: "assistant",
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
}

function createMistralToolCallIdNormalizer(): (id: string) => string {
  const idMap = new Map<string, string>();
  const reverseMap = new Map<string, string>();

  return (id: string): string => {
    const existing = idMap.get(id);
    if (existing) {
      return existing;
    }

    let attempt = 0;
    while (true) {
      const candidate = deriveMistralToolCallId(id, attempt);
      const owner = reverseMap.get(candidate);
      if (!owner || owner === id) {
        idMap.set(id, candidate);
        reverseMap.set(candidate, id);
        return candidate;
      }
      attempt++;
    }
  };
}

function deriveMistralToolCallId(id: string, attempt: number): string {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) {
    return normalized;
  }
  const seedBase = normalized || id;
  const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
  return shortHash(seed)
    .replace(/[^a-zA-Z0-9]/g, "")
    .padEnd(MISTRAL_TOOL_CALL_ID_LENGTH, "0")
    .slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function formatMistralError(error: unknown): string {
  if (error instanceof Error) {
    const sdkError = error as Error & { statusCode?: unknown; body?: unknown };
    const statusCode = typeof sdkError.statusCode === "number" ? sdkError.statusCode : undefined;
    const bodyText = typeof sdkError.body === "string" ? sdkError.body.trim() : undefined;
    if (statusCode !== undefined && bodyText) {
      return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
    }
    if (statusCode !== undefined) {
      return `Mistral API error (${statusCode}): ${error.message}`;
    }
    return error.message;
  }
  return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = truncateUtf16Safe(text, maxChars);
  return `${truncated}... [truncated ${text.length - truncated.length} chars]`;
}

function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function buildRequestOptions(model: Model<"mistral-conversations">, options?: MistralOptions) {
  const requestOptions: {
    signal?: AbortSignal;
    retries: { strategy: "none" };
    headers?: Record<string, string>;
  } = {
    retries: { strategy: "none" },
  };
  if (options?.signal) {
    requestOptions.signal = options.signal;
  }

  const headers: Record<string, string> = {};
  if (model.headers) {
    Object.assign(headers, model.headers);
  }
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  // Mistral infrastructure uses `x-affinity` for KV-cache reuse (prefix caching).
  // Respect explicit caller-provided header values.
  if (options?.sessionId && !headers["x-affinity"]) {
    headers["x-affinity"] = options.sessionId;
  }

  if (Object.keys(headers).length > 0) {
    requestOptions.headers = headers;
  }

  return requestOptions;
}

function buildChatPayload(
  model: Model<"mistral-conversations">,
  context: Context,
  messages: Message[],
  options?: MistralOptions,
): ChatCompletionStreamRequest {
  const payload: ChatCompletionStreamRequest = {
    model: model.id,
    stream: true,
    messages: toChatMessages(messages, model.input.includes("image")),
  };
  let convertedToolNames: Set<string> | undefined;

  if (context.tools?.length) {
    const tools = toFunctionTools(context.tools);
    convertedToolNames = new Set(tools.map((tool) => tool.function.name));
    if (tools.length > 0) {
      payload.tools = tools;
    }
  }
  if (options?.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options?.maxTokens !== undefined) {
    payload.maxTokens = options.maxTokens;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    payload.stop = options.stop;
  }
  if (options?.toolChoice) {
    const toolChoice = mapToolChoice(options.toolChoice, convertedToolNames);
    if (toolChoice) {
      payload.toolChoice = toolChoice;
    }
  }
  if (options?.promptMode) {
    payload.promptMode = options.promptMode;
  }
  if (options?.reasoningEffort) {
    payload.reasoningEffort = options.reasoningEffort;
  }

  if (context.systemPrompt) {
    payload.messages.unshift({
      role: "system",
      content: sanitizeSurrogates(stripSystemPromptCacheBoundary(context.systemPrompt)),
    });
  }

  return payload;
}

async function consumeChatStream(
  model: Model<"mistral-conversations">,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  mistralStream: AsyncIterable<CompletionEvent>,
): Promise<void> {
  let currentBlock: TextContent | ThinkingContent | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  type ToolBlockIdentity = {
    explicitIds: Set<string>;
    functionNames: Set<string>;
    indexes: Set<number>;
  };
  // Persist every identity fact across chunks. The SDK defaults omitted indexes
  // to zero, so only a unique compatible candidate may receive later arguments.
  const toolBlockIdentities = new Map<number, ToolBlockIdentity>();
  const normalizeMissingToolCallId = createMistralToolCallIdNormalizer();
  // Some Mistral-compatible endpoints omit tool-call ids. Their streamed index
  // is only response-local, so namespace the fallback before strict-9 hashing.
  const missingToolCallIdScope = randomUUID();
  const createMissingToolCallId = (contentIndex: number) =>
    normalizeMissingToolCallId(`${missingToolCallIdScope}:toolcall:${contentIndex}`);

  const findIdentityCandidates = (
    matches: (identity: ToolBlockIdentity) => boolean,
    excludedContentIndexes?: ReadonlySet<number>,
  ): Set<number> => {
    const candidates = new Set<number>();
    for (const [contentIndex, identity] of toolBlockIdentities) {
      if (!excludedContentIndexes?.has(contentIndex) && matches(identity)) {
        candidates.add(contentIndex);
      }
    }
    return candidates;
  };

  const intersectCandidates = (left: Set<number>, right: Set<number>): Set<number> =>
    new Set([...left].filter((contentIndex) => right.has(contentIndex)));

  const requireSingleCandidate = (candidates: Set<number>): number | undefined => {
    if (candidates.size > 1) {
      throw new Error(
        "Mistral streamed tool-call continuation is ambiguous; refusing to merge arguments",
      );
    }
    return candidates.values().next().value;
  };

  const requireExistingCandidate = (candidates: Set<number>): number => {
    const candidate = requireSingleCandidate(candidates);
    if (candidate === undefined) {
      throw new Error(
        "Mistral streamed tool-call identities conflict; refusing to merge arguments",
      );
    }
    return candidate;
  };

  const resolveToolBlockIndex = (params: {
    explicitId?: string;
    functionName?: string;
    index?: number;
    usedContentIndexes: ReadonlySet<number>;
  }): number | undefined => {
    const explicitId = params.explicitId;
    const functionName = params.functionName;
    const toolCallIndex = params.index;
    const idCandidates = explicitId
      ? findIdentityCandidates(
          (identity) => identity.explicitIds.has(explicitId),
          params.usedContentIndexes,
        )
      : new Set<number>();
    const nameCandidates = functionName
      ? findIdentityCandidates(
          (identity) => identity.functionNames.has(functionName),
          params.usedContentIndexes,
        )
      : new Set<number>();
    const indexCandidates =
      toolCallIndex === undefined
        ? new Set<number>()
        : findIdentityCandidates(
            (identity) => identity.indexes.has(toolCallIndex),
            params.usedContentIndexes,
          );

    if (idCandidates.size > 0) {
      let candidates = idCandidates;
      if (nameCandidates.size > 0) {
        candidates = intersectCandidates(candidates, nameCandidates);
      }
      return requireExistingCandidate(candidates);
    }

    if (nameCandidates.size > 0) {
      const idCompatibleCandidates = new Set(
        [...nameCandidates].filter((contentIndex) => {
          const identity = toolBlockIdentities.get(contentIndex);
          if (!identity) {
            return false;
          }
          return !explicitId || identity.explicitIds.size === 0;
        }),
      );
      if (
        idCompatibleCandidates.size <= 1 &&
        (toolCallIndex === undefined || toolCallIndex === 0)
      ) {
        // A unique persistent name is stronger than the SDK's default index
        // zero. Preserve nonzero indices, which unambiguously start or resume a
        // different call even when the provider repeats a function name.
        return requireSingleCandidate(idCompatibleCandidates);
      }
      const indexCompatibleCandidates = new Set(
        [...idCompatibleCandidates].filter((contentIndex) => {
          const identity = toolBlockIdentities.get(contentIndex);
          if (!identity) {
            return false;
          }
          return (
            toolCallIndex === undefined ||
            identity.indexes.size === 0 ||
            identity.indexes.has(toolCallIndex)
          );
        }),
      );
      if (indexCompatibleCandidates.size === 0) {
        return undefined;
      }
      return requireSingleCandidate(indexCompatibleCandidates);
    }

    if (functionName) {
      // A new name normally starts a sibling call even when the SDK's omitted
      // index default aliases an earlier block. It is a continuation only when
      // one nameless block can safely adopt the name.
      const namelessCandidates = new Set(
        [...indexCandidates].filter((contentIndex) => {
          const identity = toolBlockIdentities.get(contentIndex);
          return (
            identity?.functionNames.size === 0 && (!explicitId || identity.explicitIds.size === 0)
          );
        }),
      );
      return requireSingleCandidate(namelessCandidates);
    }

    if (explicitId) {
      // A provider id may arrive after an idless opening fragment. Adopt it
      // only when one indexed block still lacks an explicit id.
      const idlessCandidates = new Set(
        [...indexCandidates].filter(
          (contentIndex) => toolBlockIdentities.get(contentIndex)?.explicitIds.size === 0,
        ),
      );
      return requireSingleCandidate(idlessCandidates);
    }

    // With neither id nor name, index is the only remaining identity. Never
    // guess when the SDK's default index aliases multiple open tool calls.
    return requireSingleCandidate(indexCandidates);
  };

  const finishCurrentBlock = (block?: typeof currentBlock) => {
    if (!block) {
      return;
    }
    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: block.text,
        partial: output,
      });
      return;
    }
    if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: block.thinking,
        partial: output,
      });
    }
  };

  for await (const event of mistralStream) {
    const chunk = event.data;
    // Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
    // mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
    output.responseId ||= chunk.id;

    if (chunk.usage) {
      output.usage.input = chunk.usage.promptTokens || 0;
      output.usage.output = chunk.usage.completionTokens || 0;
      output.usage.cacheRead = 0;
      output.usage.cacheWrite = 0;
      output.usage.totalTokens =
        chunk.usage.totalTokens || output.usage.input + output.usage.output;
      calculateCost(model, output.usage);
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    if (choice.finishReason) {
      output.stopReason = mapChatStopReason(choice.finishReason);
    }

    const delta = choice.delta;
    if (delta.content !== null && delta.content !== undefined) {
      const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
      for (const item of contentItems) {
        if (typeof item === "string") {
          const textDelta = sanitizeSurrogates(item);
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output,
          });
          continue;
        }

        if (item.type === "thinking") {
          const deltaText = item.thinking
            .map((part) => ("text" in part ? part.text : ""))
            .filter((text) => text.length > 0)
            .join("");
          const thinkingDelta = sanitizeSurrogates(deltaText);
          if (!thinkingDelta) {
            continue;
          }
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "thinking", thinking: "" };
            output.content.push(currentBlock);
            stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.thinking += thinkingDelta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: thinkingDelta,
            partial: output,
          });
          continue;
        }

        if (item.type === "text") {
          const textDelta = sanitizeSurrogates(item.text);
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output,
          });
        }
      }
    }

    const toolCalls = delta.toolCalls || [];
    // One streamed delta carries at most one fragment per logical call. Reusing
    // a block here would collapse parallel siblings before persistent identity
    // candidates can distinguish their later continuations.
    const usedToolBlockIndexes = new Set<number>();
    for (const toolCall of toolCalls) {
      if (currentBlock) {
        finishCurrentBlock(currentBlock);
        currentBlock = null;
      }
      const toolCallIndex =
        typeof toolCall.index === "number" && Number.isInteger(toolCall.index)
          ? toolCall.index
          : undefined;
      const providedCallId = toolCall.id && toolCall.id !== "null" ? toolCall.id : undefined;
      const functionName = toolCall.function.name.trim() || undefined;
      const existingIndex = resolveToolBlockIndex({
        explicitId: providedCallId,
        functionName,
        index: toolCallIndex,
        usedContentIndexes: usedToolBlockIndexes,
      });
      let block: (ToolCall & { partialArgs?: string }) | undefined;

      if (existingIndex !== undefined) {
        const existing = output.content[existingIndex];
        if (existing?.type === "toolCall") {
          block = existing as ToolCall & { partialArgs?: string };
        }
      }
      if (!block) {
        const contentIndex = output.content.length;
        block = {
          type: "toolCall",
          id: providedCallId ?? createMissingToolCallId(contentIndex),
          name: functionName ?? "",
          arguments: {},
          partialArgs: "",
        };
        output.content.push(block);
        toolBlockIdentities.set(contentIndex, {
          explicitIds: new Set(providedCallId ? [providedCallId] : []),
          functionNames: new Set(functionName ? [functionName] : []),
          indexes: new Set(toolCallIndex === undefined ? [] : [toolCallIndex]),
        });
        stream.push({
          type: "toolcall_start",
          contentIndex,
          partial: output,
        });
      }
      const contentIndex = output.content.indexOf(block);
      const identity = toolBlockIdentities.get(contentIndex);
      if (!identity) {
        throw new Error("Mistral streamed tool-call identity is missing");
      }
      usedToolBlockIndexes.add(contentIndex);
      if (providedCallId) {
        block.id = providedCallId;
        identity.explicitIds.add(providedCallId);
      }
      if (functionName) {
        if (identity.functionNames.size > 0 && !identity.functionNames.has(functionName)) {
          throw new Error(
            "Mistral streamed tool-call continuation changed function name; refusing to merge arguments",
          );
        }
        block.name = functionName;
        identity.functionNames.add(functionName);
      }
      if (toolCallIndex !== undefined) {
        identity.indexes.add(toolCallIndex);
      }

      const argsDelta =
        typeof toolCall.function.arguments === "string"
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments || {});
      block.partialArgs = (block.partialArgs || "") + argsDelta;
      block.arguments = parseStreamingJson(block.partialArgs);
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: argsDelta,
        partial: output,
      });
    }
  }

  finishCurrentBlock(currentBlock);
  for (const index of toolBlockIdentities.keys()) {
    const block = output.content[index];
    if (block.type !== "toolCall") {
      continue;
    }
    const toolBlock = block as ToolCall & { partialArgs?: string };
    toolBlock.arguments = parseStreamingJson(toolBlock.partialArgs);
    // Finalize in-place and strip the scratch buffer so replay only
    // carries parsed arguments.
    delete toolBlock.partialArgs;
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: toolBlock,
      partial: output,
    });
  }
}

function toFunctionTools(tools: Tool[]): Array<FunctionTool & { type: "function" }> {
  return tools.flatMap((tool) => {
    try {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: stripSymbolKeys(tool.parameters) as Record<string, unknown>,
          strict: false,
        },
      };
    } catch {
      return [];
    }
  });
}

function stripSymbolKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSymbolKeys(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = stripSymbolKeys(entry);
    }
    return result;
  }

  return value;
}

function toChatMessages(
  messages: Message[],
  supportsImages: boolean,
): ChatCompletionStreamRequestMessage[] {
  const result: ChatCompletionStreamRequestMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        continue;
      }
      const hadImages = msg.content.some((item) => item.type === "image");
      const content: ContentChunk[] = msg.content
        .filter((item) => item.type === "text" || supportsImages)
        .map((item) => {
          if (item.type === "text") {
            return { type: "text", text: sanitizeSurrogates(item.text) };
          }
          return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
        });
      if (content.length > 0) {
        result.push({ role: "user", content });
        continue;
      }
      if (hadImages && !supportsImages) {
        result.push({ role: "user", content: "(image omitted: model does not support images)" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const contentParts: ContentChunk[] = [];
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.thinking.trim().length > 0) {
            contentParts.push({
              type: "thinking",
              thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
            });
          }
          continue;
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
        });
      }

      const assistantMessage: ChatCompletionStreamRequestMessage = { role: "assistant" };
      if (contentParts.length > 0) {
        assistantMessage.content = contentParts;
      }
      if (toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls;
      }
      if (contentParts.length > 0 || toolCalls.length > 0) {
        result.push(assistantMessage);
      }
      continue;
    }

    const toolContent: ContentChunk[] = [];
    const textResult = extractToolResultText(msg.content);
    const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
    const hasImages = msg.content.some((part) => part.type === "image");
    const toolText = buildToolResultText(
      textResult,
      mediaPlaceholder,
      hasImages,
      supportsImages,
      msg.isError,
    );
    toolContent.push({ type: "text", text: toolText });
    for (const part of msg.content) {
      if (!supportsImages) {
        continue;
      }
      if (part.type !== "image") {
        continue;
      }
      toolContent.push({
        type: "image_url",
        imageUrl: `data:${part.mimeType};base64,${part.data}`,
      });
    }
    result.push({
      role: "tool",
      toolCallId: msg.toolCallId,
      name: msg.toolName,
      content: toolContent,
    });
  }

  return result;
}

function buildToolResultText(
  text: string,
  mediaPlaceholder: string | undefined,
  hasImages: boolean,
  supportsImages: boolean,
  isError: boolean,
): string {
  const trimmed = text.trim();
  const errorPrefix = isError ? "[tool error] " : "";

  if (trimmed.length > 0) {
    const imageSuffix =
      hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
    return `${errorPrefix}${trimmed}${imageSuffix}`;
  }

  if (mediaPlaceholder) {
    if (!hasImages || supportsImages) {
      return `${errorPrefix}${mediaPlaceholder}`;
    }
    const omitted =
      mediaPlaceholder === "(see attached media)"
        ? "(media omitted: model does not support images)"
        : "(image omitted: model does not support images)";
    return `${errorPrefix}${omitted}`;
  }

  return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
  return (
    model.id === "mistral-small-2603" ||
    model.id === "mistral-small-latest" ||
    model.id === "mistral-medium-3-5"
  );
}

function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
  return model.reasoning && !usesReasoningEffort(model);
}

function mapReasoningEffort(
  model: Model<"mistral-conversations">,
  level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): MistralReasoningEffort {
  return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

function mapToolChoice(
  choice: MistralOptions["toolChoice"],
  convertedToolNames?: ReadonlySet<string>,
):
  | "auto"
  | "none"
  | "any"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined {
  if (!choice) {
    return undefined;
  }
  if (convertedToolNames && convertedToolNames.size === 0) {
    if (choice === "none" || choice === "auto") {
      return choice === "none" ? "none" : undefined;
    }
    throw new Error("Mistral tool_choice requires a tool, but no tools survived schema conversion");
  }
  if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
    return choice;
  }
  const toolName = choice.function.name;
  if (convertedToolNames && !convertedToolNames.has(toolName)) {
    throw new Error(
      `Mistral tool_choice requested unavailable tool "${toolName}" after schema conversion`,
    );
  }
  return {
    type: "function",
    function: { name: toolName },
  };
}

function mapChatStopReason(reason: string | null): StopReason {
  if (reason === null) {
    return "stop";
  }
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
    case "model_length":
      return "length";
    case "tool_calls":
      return "toolUse";
    case "error":
      return "error";
    default:
      return "stop";
  }
}
