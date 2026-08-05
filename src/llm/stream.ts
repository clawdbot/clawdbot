// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { defaultApiRegistry, defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { getModelLlmRuntime } from "./model-runtime-binding.js";
import "./ai-transport-host.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "./types.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

registerBuiltInApiProviders(defaultApiRegistry);

let transportRuntimeHostPromise: Promise<void> | undefined;

async function ensureTransportRuntimeHost(): Promise<void> {
  // Async completion entry points install heavy provider ports before the runtime
  // can invoke them, without adding their plugin graph to this eager facade.
  transportRuntimeHostPromise ??= import("../agents/ai-transport-runtime-host.js").then(
    ({ configureAiTransportRuntimeHost }) => configureAiTransportRuntimeHost(),
  );
  await transportRuntimeHostPromise;
}

function createRuntimeHostErrorMessage(model: Model, error: unknown): AssistantMessage {
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
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function deferUntilTransportRuntimeHost(
  model: Model,
  start: () => AssistantMessageEventStreamContract,
): AssistantMessageEventStreamContract {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      await ensureTransportRuntimeHost();
      for await (const event of start()) {
        output.push(event);
      }
    } catch (error) {
      const message = createRuntimeHostErrorMessage(model, error);
      output.push({ type: "error", reason: "error", error: message });
    } finally {
      output.end();
    }
  })();
  return output;
}

function resolveRuntime(model: Model) {
  return getModelLlmRuntime(model) ?? defaultLlmRuntime;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, () =>
    resolveRuntime(model).stream(model, context, options),
  );
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  return await resolveRuntime(model).complete(model, context, options);
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, () =>
    resolveRuntime(model).streamSimple(model, context, options),
  );
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  return await resolveRuntime(model).completeSimple(model, context, options);
}
