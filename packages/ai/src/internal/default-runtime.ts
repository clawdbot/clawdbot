// Process-default registry/runtime retained for the OpenClaw compatibility
// facade (src/llm). Deliberately not part of the public package API: external
// consumers create isolated runtimes via createLlmRuntime(); exporting these
// from the root barrel would reintroduce the mutable process-global registry.
import { createApiRegistry, type ApiRegistry } from "../api-registry.js";
import { createLlmRuntime, type LlmRuntime } from "../stream.js";

type DefaultRuntimeState = {
  registry: ApiRegistry;
  runtime: LlmRuntime;
};

const DEFAULT_RUNTIME_KEY = Symbol.for("openclaw.ai.defaultRuntime");

function resolveDefaultRuntime(): DefaultRuntimeState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.hasOwn(globalStore, DEFAULT_RUNTIME_KEY)) {
    return globalStore[DEFAULT_RUNTIME_KEY] as DefaultRuntimeState;
  }
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const state = { registry, runtime };
  globalStore[DEFAULT_RUNTIME_KEY] = state;
  return state;
}

const defaultRuntime = resolveDefaultRuntime();

export const defaultApiRegistry = defaultRuntime.registry;
export const defaultLlmRuntime = defaultRuntime.runtime;

export const { getApiProvider, getApiProviders } = defaultApiRegistry;

export function clearApiProviders(): void {
  defaultApiRegistry.clearApiProviders();
}

export const { stream, complete, streamSimple, completeSimple } = defaultLlmRuntime;
