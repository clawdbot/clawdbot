import { randomUUID } from "node:crypto";
import type {
  ChatHistoryItem,
  ChatModelFunctions,
  Llama,
  LlamaContext,
  LlamaContextSequence,
  LlamaChatResponseChunk,
  LlamaChatResponseFunctionCallParamsChunk,
  LlamaModel,
} from "node-llama-cpp";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, Context, StopReason, ToolCall } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream, parseStreamingJson } from "openclaw/plugin-sdk/llm";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createPlainTextToolCallCompatWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  buildMessage,
  runtimeUnavailableErrorMessage,
  runtimeUnavailableMessage,
  zeroCostUsage,
} from "./inference-messages.js";
import {
  createLlamaCppInferenceRuntimeToken,
  type LlamaCppInferenceRuntimeToken,
} from "./inference-runtime-coordinator.js";
import {
  formatLlamaCppSetupError,
  importNodeLlamaCpp,
  type NodeLlamaCppModule,
} from "./node-llama.runtime.js";

type LoadedModel = {
  key: string;
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
};

type LlamaJsonSchemaInput = Parameters<Llama["createGrammarForJsonSchema"]>[0];

type LlamaCppInferenceRuntimeState = {
  admission: LlamaCppInferenceRuntimeToken;
  loadedModel?: LoadedModel;
  llamaInstance?: Llama;
  operationQueue: Promise<void>;
  lifecycle: "open" | "closing" | "closed";
  cleanupFailure?: { error: Error };
  retiringRuntimeFailure?: boolean;
  disposePromise?: Promise<void>;
};

type LlamaCppInferenceRuntime = {
  createStreamFn: (params: { providerConfig?: ModelProviderConfig }) => StreamFn;
  dispose: () => Promise<void>;
};

function runtimeRequiresRestart(state: LlamaCppInferenceRuntimeState): boolean {
  return Boolean(state.cleanupFailure || state.retiringRuntimeFailure);
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

async function resolveLlamaCppResponseGrammar(params: {
  llama: Llama;
  responseFormat: Record<string, unknown> | undefined;
}) {
  const responseFormat = params.responseFormat;
  if (!responseFormat) {
    return undefined;
  }
  if (Object.keys(responseFormat).length === 0) {
    return await params.llama.getGrammarFor("json");
  }
  if (responseFormat.type === "json_object") {
    return await params.llama.getGrammarFor("json");
  }
  if (responseFormat.type === "text") {
    return undefined;
  }
  if (responseFormat.type === "json_schema") {
    const envelope = normalizeArguments(responseFormat.json_schema);
    const schema = normalizeArguments(envelope.schema);
    return Object.keys(schema).length > 0
      ? await params.llama.createGrammarForJsonSchema(schema as LlamaJsonSchemaInput)
      : await params.llama.getGrammarFor("json");
  }
  return await params.llama.createGrammarForJsonSchema(responseFormat as LlamaJsonSchemaInput);
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
  const advertisedCap =
    typeof model.contextWindow === "number" && model.contextWindow > 0
      ? Math.floor(model.contextWindow)
      : DEFAULT_LLAMA_CPP_CONTEXT_SIZE;
  // Advertised capacity is a ceiling, not permission to silently exceed the
  // established local-memory default; explicit runtime caps can still opt in.
  const modelCap =
    typeof model.contextTokens === "number" && model.contextTokens > 0
      ? Math.floor(model.contextTokens)
      : Math.min(advertisedCap, DEFAULT_LLAMA_CPP_CONTEXT_SIZE);
  return { max: modelCap };
}

async function disposeLoadedModel(state: LlamaCppInferenceRuntimeState): Promise<void> {
  if (!state.loadedModel) {
    return;
  }
  const previous = state.loadedModel;
  state.loadedModel = undefined;
  try {
    await previous.context.dispose();
    await previous.model.dispose();
  } catch (error) {
    recordCleanupFailure(state, error);
    throw error;
  }
}

function recordCleanupFailure(state: LlamaCppInferenceRuntimeState, error: unknown): void {
  state.cleanupFailure ??= { error: error instanceof Error ? error : new Error(String(error)) };
  state.lifecycle = "closed";
  state.admission.fail(state.cleanupFailure.error);
}

function recordRetiringRuntimeFailure(state: LlamaCppInferenceRuntimeState): void {
  state.retiringRuntimeFailure = true;
  state.lifecycle = "closed";
}

async function getLoadedModel(params: {
  state: LlamaCppInferenceRuntimeState;
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
  if (params.state.loadedModel?.key === key) {
    return params.state.loadedModel;
  }
  await disposeLoadedModel(params.state);
  const llama = params.state.llamaInstance ?? (await params.runtime.getLlama());
  params.state.llamaInstance = llama;
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
    params.state.loadedModel = { key, llama, model, context, sequence };
    return params.state.loadedModel;
  } catch (error) {
    try {
      await context?.dispose();
      await model.dispose();
    } catch (cleanupError) {
      recordCleanupFailure(params.state, cleanupError);
      throw cleanupError;
    }
    throw error;
  }
}

async function serialize(
  state: LlamaCppInferenceRuntimeState,
  operation: () => Promise<void>,
): Promise<void> {
  const current = state.operationQueue.then(operation, operation);
  state.operationQueue = current.catch(() => undefined);
  await current;
}

function disposeLlamaCppInferenceRuntime(state: LlamaCppInferenceRuntimeState): Promise<void> {
  if (state.disposePromise) {
    return state.disposePromise;
  }
  if (state.cleanupFailure) {
    state.disposePromise = Promise.reject(state.cleanupFailure.error);
    return state.disposePromise;
  }
  state.lifecycle = "closing";
  state.admission.close();
  // node-llama-cpp disposers are one-shot and child cleanup releases the
  // parent's disposal guard. Do not force parent cleanup after a child rejects:
  // the retained guard can make that parent disposer wait forever.
  state.disposePromise = serialize(state, async () => {
    if (state.cleanupFailure) {
      throw state.cleanupFailure.error;
    }
    await disposeLoadedModel(state);
    if (state.llamaInstance) {
      const previous = state.llamaInstance;
      await previous.dispose();
      if (state.llamaInstance === previous) {
        state.llamaInstance = undefined;
      }
    }
    state.admission.release();
  })
    .catch((error: unknown) => {
      recordCleanupFailure(state, error);
      throw error;
    })
    .finally(() => {
      state.lifecycle = "closed";
    });
  return state.disposePromise;
}

function createLlamaCppStreamFnForRuntime(
  state: LlamaCppInferenceRuntimeState,
  params: { providerConfig?: ModelProviderConfig },
): StreamFn {
  return createPlainTextToolCallCompatWrapper((model, context, options) => {
    const stream = createAssistantMessageEventStream();
    if (state.lifecycle !== "open") {
      stream.push({
        type: "error",
        reason: "error",
        error: runtimeUnavailableMessage(model, runtimeRequiresRestart(state)),
      });
      stream.end();
      return stream;
    }
    let streamedText = "";
    const streamedContent: AssistantMessage["content"] = [];
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
        if (state.lifecycle !== "open") {
          stream.push({
            type: "error",
            reason: "error",
            error: runtimeUnavailableMessage(model, runtimeRequiresRestart(state)),
          });
          return;
        }
        await state.admission.acquire({
          signal,
          isLive: () => state.lifecycle === "open",
          onRestartRequired: () => recordRetiringRuntimeFailure(state),
        });
        if (state.lifecycle !== "open") {
          throw new Error("llama.cpp runtime is stopping");
        }
        const runtime = await importNodeLlamaCpp();
        const loaded = await getLoadedModel({
          state,
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
        const functions = mapToolsToLlamaFunctions(context);
        const streamedToolCalls = new Map<
          number,
          { toolCall: ToolCall; contentIndex: number; partialArgs: string }
        >();
        let streamStarted = false;
        let activeThinking: { contentIndex: number; thinking: string } | undefined;
        let activeText: { contentIndex: number; text: string } | undefined;
        const partial = () =>
          buildMessage({
            model,
            content: [...streamedContent],
            stopReason: "stop",
          });
        const ensureStreamStarted = () => {
          if (streamStarted) {
            return;
          }
          streamStarted = true;
          stream.push({ type: "start", partial: partial() });
        };
        const closeThinkingBlock = () => {
          if (!activeThinking) {
            return;
          }
          const thinking = activeThinking;
          activeThinking = undefined;
          stream.push({
            type: "thinking_end",
            contentIndex: thinking.contentIndex,
            content: thinking.thinking,
            partial: partial(),
          });
        };
        const closeTextBlock = () => {
          if (!activeText) {
            return;
          }
          const text = activeText;
          activeText = undefined;
          stream.push({
            type: "text_end",
            contentIndex: text.contentIndex,
            content: text.text,
            partial: partial(),
          });
        };
        const appendThinkingChunk = (chunk: LlamaChatResponseChunk) => {
          if (chunk.type !== "segment" || chunk.segmentType !== "thought") {
            return;
          }
          if (chunk.text) {
            closeTextBlock();
            if (!activeThinking) {
              ensureStreamStarted();
              activeThinking = { contentIndex: streamedContent.length, thinking: "" };
              streamedContent.push({ type: "thinking", thinking: "" });
              stream.push({
                type: "thinking_start",
                contentIndex: activeThinking.contentIndex,
                partial: partial(),
              });
            }
            activeThinking.thinking += chunk.text;
            streamedContent[activeThinking.contentIndex] = {
              type: "thinking",
              thinking: activeThinking.thinking,
            };
            stream.push({
              type: "thinking_delta",
              contentIndex: activeThinking.contentIndex,
              delta: chunk.text,
              partial: partial(),
            });
          }
          if (chunk.segmentEndTime) {
            closeThinkingBlock();
          }
        };
        const appendTextDelta = (delta: string) => {
          if (!delta) {
            return;
          }
          closeThinkingBlock();
          if (!activeText) {
            ensureStreamStarted();
            activeText = { contentIndex: streamedContent.length, text: "" };
            streamedContent.push({ type: "text", text: "" });
            stream.push({
              type: "text_start",
              contentIndex: activeText.contentIndex,
              partial: partial(),
            });
          }
          streamedText += delta;
          activeText.text += delta;
          streamedContent[activeText.contentIndex] = { type: "text", text: activeText.text };
          stream.push({
            type: "text_delta",
            contentIndex: activeText.contentIndex,
            delta,
          });
        };
        const appendFunctionCallParamsChunk = (chunk: LlamaChatResponseFunctionCallParamsChunk) => {
          closeThinkingBlock();
          closeTextBlock();
          let callState = streamedToolCalls.get(chunk.callIndex);
          if (!callState) {
            ensureStreamStarted();
            callState = {
              toolCall: {
                type: "toolCall",
                id: `llama_cpp_call_${randomUUID()}`,
                name: chunk.functionName,
                arguments: {},
              },
              contentIndex: streamedContent.length,
              partialArgs: "",
            };
            streamedToolCalls.set(chunk.callIndex, callState);
            streamedContent.push(callState.toolCall);
            stream.push({
              type: "toolcall_start",
              contentIndex: callState.contentIndex,
              partial: partial(),
            });
          }
          if (chunk.paramsChunk) {
            callState.partialArgs += chunk.paramsChunk;
            // Replace the block so already queued partial snapshots retain the
            // exact argument state they exposed before this streamed delta.
            callState.toolCall = {
              ...callState.toolCall,
              arguments: parseStreamingJson(callState.partialArgs),
            };
            streamedContent[callState.contentIndex] = callState.toolCall;
            stream.push({
              type: "toolcall_delta",
              contentIndex: callState.contentIndex,
              delta: chunk.paramsChunk,
              partial: partial(),
            });
          }
        };
        try {
          // node-llama-cpp makes grammar and functions mutually exclusive. Tool
          // turns keep function calling; constrained decoding is for tool-free turns.
          const grammar =
            functions || !options?.responseFormat
              ? undefined
              : await resolveLlamaCppResponseGrammar({
                  llama: loaded.llama,
                  responseFormat: options.responseFormat,
                });
          const generationOptions = {
            signal: options?.signal,
            maxTokens: options?.maxTokens ?? model.maxTokens,
            temperature: options?.temperature,
            customStopTriggers: options?.stop,
            onTextChunk: appendTextDelta,
            ...(model.reasoning ? { onResponseChunk: appendThinkingChunk } : {}),
            ...(functions
              ? {
                  functions,
                  documentFunctionParams: true as const,
                  onFunctionCallParamsChunk: appendFunctionCallParamsChunk,
                }
              : grammar
                ? { grammar }
                : {}),
          };
          const result = await chat.generateResponse(
            mapContextToLlamaChatHistory(context),
            generationOptions,
          );
          if (result.metadata.stopReason === "abort" || signal?.aborted) {
            generationAborted = true;
            throw signal?.reason ?? new Error("Request was aborted");
          }
          const usageDelta = sequence.tokenMeter.diff(before);
          if (!streamedText && result.response) {
            appendTextDelta(result.response);
          }
          closeThinkingBlock();
          closeTextBlock();
          // A max-token result can contain previously completed calls while a
          // later call was truncated. Its terminal owns the entire generation.
          const confirmedCalls =
            result.metadata.stopReason === "maxTokens" ? [] : (result.functionCalls ?? []);
          const toolCalls: ToolCall[] = confirmedCalls.map((call, callIndex) => {
            let callState = streamedToolCalls.get(callIndex);
            const argumentsObject = normalizeArguments(call.params);
            if (!callState) {
              appendFunctionCallParamsChunk({
                callIndex,
                functionName: call.functionName,
                paramsChunk: JSON.stringify(argumentsObject),
                done: true,
              });
              callState = streamedToolCalls.get(callIndex);
            }
            if (!callState) {
              throw new Error("llama.cpp native tool call stream state is missing");
            }
            callState.toolCall = {
              ...callState.toolCall,
              name: call.functionName,
              arguments: argumentsObject,
            };
            streamedContent[callState.contentIndex] = callState.toolCall;
            // The dependency reports its final argument chunk before checking the
            // token budget; only this authoritative result can complete a call.
            stream.push({
              type: "toolcall_end",
              contentIndex: callState.contentIndex,
              toolCall: callState.toolCall,
              partial: partial(),
            });
            return callState.toolCall;
          });
          const confirmedToolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
          const content = streamedContent.filter(
            (block) => block.type !== "toolCall" || confirmedToolCallIds.has(block.id),
          );
          const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
            result.metadata.stopReason === "maxTokens"
              ? "length"
              : toolCalls.length > 0
                ? "toolUse"
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
        const errorMessage = aborted
          ? "Request was aborted"
          : state.lifecycle !== "open"
            ? runtimeUnavailableErrorMessage(runtimeRequiresRestart(state))
            : formatLlamaCppSetupError(error);
        stream.push({
          type: "error",
          reason,
          error: buildMessage({
            model,
            content: streamedContent.filter((block) => block.type !== "toolCall"),
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
      void serialize(state, run);
    }
    return stream;
  });
}

export function createLlamaCppInferenceRuntime(): LlamaCppInferenceRuntime {
  const state: LlamaCppInferenceRuntimeState = {
    admission: createLlamaCppInferenceRuntimeToken(),
    operationQueue: Promise.resolve(),
    lifecycle: "open",
  };
  return {
    createStreamFn: (params) => createLlamaCppStreamFnForRuntime(state, params),
    dispose: () => disposeLlamaCppInferenceRuntime(state),
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const testApiKey = Symbol.for("openclaw.llamaCppInferenceTestApi");
  Object.assign((globalStore[testApiKey] ??= {}), {
    mapContextToLlamaChatHistory,
    mapToolsToLlamaFunctions,
  });
}
