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

registerBuiltInApiProviders(defaultApiRegistry);

function resolveRuntime(model: Model) {
  return getModelLlmRuntime(model) ?? defaultLlmRuntime;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStreamContract {
  return resolveRuntime(model).stream(model, context, options);
}

export function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  return resolveRuntime(model).complete(model, context, options);
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  return resolveRuntime(model).streamSimple(model, context, options);
}

export function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return resolveRuntime(model).completeSimple(model, context, options);
}
