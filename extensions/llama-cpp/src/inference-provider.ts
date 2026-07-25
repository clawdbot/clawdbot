import { randomUUID } from "node:crypto";
import type {
  ChatHistoryItem,
  ChatModelFunctions,
  Llama,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
} from "node-llama-cpp";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  AssistantMessage,
  Context,
  StopReason,
  ToolCall,
  Usage,
} from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  formatLlamaCppSetupError,
  importNodeLlamaCpp,
  type NodeLlamaCppModule,
} from "./node-llama.runtime.js";

type LoadedModel = {
  key: string;
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
};

// Process-owned, single-slot cache. A model/context pair lives until another
// model replaces it or the process exits, bounding resident model memory.
let loadedModel: LoadedModel | undefined;
let llamaInstance: Llama | undefined;
let operationQueue: Promise<void> = Promise.resolve();

function zeroCostUsage(input = 0, output = 0): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildMessage(params: {
  model: Parameters<StreamFn>[0];
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage?: Usage;
  errorMessage?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    stopReason: params.stopReason,
    usage: params.usage ?? zeroCostUsage(),
    timestamp: Date.now(),
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) && typeof part === "object" && part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapContextToLlamaChatHistory(context: Context): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];
  if (context.systemPrompt?.trim()) {
    history.push({ type: "system", text: context.systemPrompt });
  }
  const toolResults = new Map(
    context.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => [message.toolCallId, extractText(message.content)]),
  );
  const consumedToolResults = new Set<string>();

  for (const message of context.messages) {
    if (message.role === "user") {
      history.push({ type: "user", text: extractText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const response: Extract<ChatHistoryItem, { type: "model" }>["response"] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text) {
            response.push(part.text);
          }
          continue;
        }
        if (part.type === "thinking") {
          if (part.thinking) {
            response.push({
              type: "segment",
              segmentType: "thought",
              text: part.thinking,
              ended: true,
            });
          }
          continue;
        }
        const result = toolResults.get(part.id);
        if (result !== undefined) {
          consumedToolResults.add(part.id);
        }
        response.push({
          type: "functionCall",
          name: part.name,
          params: part.arguments,
          result: result ?? "",
        });
      }
      history.push({ type: "model", response });
      continue;
    }
    if (!consumedToolResults.has(message.toolCallId)) {
      history.push({
        type: "user",
        text: `Tool result (${message.toolName}): ${extractText(message.content)}`,
      });
    }
  }
  return history;
}

function mapToolsToLlamaFunctions(context: Context): ChatModelFunctions | undefined {
  if (!context.tools?.length) {
    return undefined;
  }
  return Object.fromEntries(
    context.tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        params: tool.parameters as ChatModelFunctions[string]["params"],
      },
    ]),
  );
}

function readContextSizeValue(value: unknown): number | "auto" | undefined {
  if (value === "auto") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveContextSize(
  model: Parameters<StreamFn>[0],
  providerConfig?: ModelProviderConfig,
): number | { max: number } {
  const configured =
    readContextSizeValue(model.params?.contextSize) ??
    readContextSizeValue(providerConfig?.params?.contextSize);
  if (typeof configured === "number") {
    return configured;
  }
  const modelCap =
    typeof model.contextTokens === "number" && model.contextTokens > 0
      ? Math.floor(model.contextTokens)
      : DEFAULT_LLAMA_CPP_CONTEXT_SIZE;
  return { max: modelCap };
}

async function disposeLoadedModel(): Promise<void> {
  if (!loadedModel) {
    return;
  }
  const previous = loadedModel;
  loadedModel = undefined;
  await previous.context.dispose();
  await previous.model.dispose();
}

async function getLoadedModel(params: {
  runtime: NodeLlamaCppModule;
  model: Parameters<StreamFn>[0];
  providerConfig?: ModelProviderConfig;
  signal?: AbortSignal;
}): Promise<LoadedModel> {
  const source = resolveLlamaCppModelSource(params.model);
  const modelPath = await params.runtime.resolveModelFile(source, {
    directory: resolveLlamaCppModelCacheDir(params.providerConfig),
    download: false,
  });
  const contextSize = resolveContextSize(params.model, params.providerConfig);
  const key = `${modelPath}\0${JSON.stringify(contextSize)}`;
  if (loadedModel?.key === key) {
    return loadedModel;
  }
  await disposeLoadedModel();
  const llama = llamaInstance ?? (await params.runtime.getLlama());
  llamaInstance = llama;
  const fitContextSize = typeof contextSize === "number" ? contextSize : contextSize.max;
  const model = await llama.loadModel({
    modelPath,
    loadSignal: params.signal,
    gpuLayers: { fitContext: { contextSize: fitContextSize } },
  });
  let context: LlamaContext | undefined;
  try {
    context = await model.createContext({ contextSize, createSignal: params.signal });
    // Serialized requests reuse this one sequence. Disposing/reallocating it per
    // turn races node-llama-cpp's asynchronous sequence-id reclamation.
    const sequence = context.getSequence();
    loadedModel = { key, model, context, sequence };
    return loadedModel;
  } catch (error) {
    await context?.dispose();
    await model.dispose();
    throw error;
  }
}

async function serialize(operation: () => Promise<void>): Promise<void> {
  const current = operationQueue.then(operation, operation);
  operationQueue = current.catch(() => undefined);
  await current;
}

async function clearLlamaCppInferenceCacheForTests(): Promise<void> {
  await serialize(async () => {
    await disposeLoadedModel();
    if (llamaInstance) {
      await llamaInstance.dispose();
      llamaInstance = undefined;
    }
  });
}

export function createLlamaCppStreamFn(params: { providerConfig?: ModelProviderConfig }): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    let streamedText = "";
    let generationAborted = false;
    let started = false;
    let ended = false;
    const signal = options?.signal;
    const abortWhileQueued = () => {
      if (started || ended) {
        return;
      }
      ended = true;
      stream.push({
        type: "error",
        reason: "aborted",
        error: buildMessage({
          model,
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        }),
      });
      stream.end();
    };
    signal?.addEventListener("abort", abortWhileQueued, { once: true });
    if (signal?.aborted) {
      abortWhileQueued();
    }
    const run = async () => {
      if (ended) {
        return;
      }
      started = true;
      signal?.removeEventListener("abort", abortWhileQueued);
      try {
        const runtime = await importNodeLlamaCpp();
        const loaded = await getLoadedModel({
          runtime,
          model,
          providerConfig: params.providerConfig,
          signal: options?.signal,
        });
        const sequence = loaded.sequence;
        const chat = new runtime.LlamaChat({
          contextSequence: sequence,
          chatWrapper: "auto",
          autoDisposeSequence: false,
        });
        const before = sequence.tokenMeter.getState();
        let textStarted = false;
        const partial = () =>
          buildMessage({
            model,
            content: streamedText ? [{ type: "text", text: streamedText }] : [],
            stopReason: "stop",
          });
        const appendTextDelta = (delta: string) => {
          if (!delta) {
            return;
          }
          if (!textStarted) {
            textStarted = true;
            stream.push({ type: "start", partial: partial() });
            stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
          }
          streamedText += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta });
        };
        try {
          const result = await chat.generateResponse(mapContextToLlamaChatHistory(context), {
            functions: mapToolsToLlamaFunctions(context),
            documentFunctionParams: true,
            signal: options?.signal,
            maxTokens: options?.maxTokens ?? model.maxTokens,
            temperature: options?.temperature,
            customStopTriggers: options?.stop,
            onTextChunk: appendTextDelta,
          });
          if (result.metadata.stopReason === "abort" || signal?.aborted) {
            generationAborted = true;
            throw signal?.reason ?? new Error("Request was aborted");
          }
          const usageDelta = sequence.tokenMeter.diff(before);
          if (!streamedText && result.response) {
            appendTextDelta(result.response);
          }
          const content: AssistantMessage["content"] = streamedText
            ? [{ type: "text", text: streamedText }]
            : [];
          if (textStarted) {
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: streamedText,
              partial: partial(),
            });
          }
          const toolCalls: ToolCall[] = (result.functionCalls ?? []).map((call) => ({
            type: "toolCall",
            id: `llama_cpp_call_${randomUUID()}`,
            name: call.functionName,
            arguments: normalizeArguments(call.params),
          }));
          content.push(...toolCalls);
          const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
            toolCalls.length > 0
              ? "toolUse"
              : result.metadata.stopReason === "maxTokens"
                ? "length"
                : "stop";
          const message = buildMessage({
            model,
            content,
            stopReason: reason,
            usage: zeroCostUsage(usageDelta.usedInputTokens, usageDelta.usedOutputTokens),
          });
          stream.push({ type: "done", reason, message });
        } finally {
          chat.dispose();
        }
      } catch (error) {
        const aborted = generationAborted || options?.signal?.aborted === true;
        const reason = aborted ? "aborted" : "error";
        const errorMessage = aborted ? "Request was aborted" : formatLlamaCppSetupError(error);
        stream.push({
          type: "error",
          reason,
          error: buildMessage({
            model,
            content: streamedText ? [{ type: "text", text: streamedText }] : [],
            stopReason: reason,
            errorMessage,
          }),
        });
      } finally {
        ended = true;
        stream.end();
      }
    };
    if (!ended) {
      queueMicrotask(() => void serialize(run));
    }
    return stream;
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.llamaCppInferenceTestApi")] = {
    mapContextToLlamaChatHistory,
    mapToolsToLlamaFunctions,
    clearLlamaCppInferenceCacheForTests,
  };
}
