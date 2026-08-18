import type { Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { codeModeToolSurfaceObserver, type OpenAICompletionsOptions } from "../provider-options.js";
import { finalizeOpenAICompletionsToolCalls } from "../providers/openai-completions-tool-calls.js";
import { tagUnresolvedTextAsCommentary } from "../utils/assistant-text-phase.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";
import { isAzureOpenAICompatibleHost } from "./openai-completions-host.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import {
  processCompletionsStream,
  shouldEmitOpenAICompletionsReasoning,
} from "./openai-completions-stream.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";
import {
  createOpenAIProviderAcceptanceHook,
  createOpenAIResponseHook,
  type MutableAssistantOutput,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  withProviderResponseHook,
} from "./transport-stream-shared.js";

export { buildOpenAICompletionsParams } from "./openai-completions-params.js";

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
    const { eventStream, stream } = createWritableTransportEventStream();
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
          const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
          enforceCodeModeResponsesToolSurface(
            params,
            visibleToolNames,
            undefined,
            codeModeToolSurfaceObserver.get(options),
          );
          assertCodeModeResponsesToolSurface(params, visibleToolNames);
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
        const { data: responseStream, response } = await client.chat.completions
          .create(
            params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
              timeoutMs: options?.timeoutMs,
              maxRetries: options?.maxRetries,
            }),
          )
          .withResponse();
        const hookedResponseStream = withProviderResponseHook({
          stream: responseStream,
          signal: firstEventAbort.signal,
          abort: firstEventAbort.abort,
          hook: options?.onProviderAccepted
            ? createOpenAIProviderAcceptanceHook(options, response, model)
            : createOpenAIResponseHook(options?.onResponse, response, model),
          onReady: () => stream.push({ type: "start", partial: output }),
        });
        await processCompletionsStream(hookedResponseStream, output, model, stream, {
          signal: options?.signal,
          emitReasoning,
          firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
          sawStreamDONE: doneDetector.sawDone,
        });
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
            tagUnresolvedTextAsCommentary(output);
          },
        });
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream;
  };
}
