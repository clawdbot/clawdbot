import {
  createApiRegistry,
  createLlmRuntime,
  type ApiRegistry,
  type LlmRuntime,
} from "@openclaw/ai";
import { getPublishedApiProviders } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import "../../llm/ai-transport-host.js";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";

type ModelRegistryRuntime = {
  apiRegistry: ApiRegistry;
  llmRuntime: LlmRuntime;
};

const modelRegistryRuntimes = new WeakMap<object, ModelRegistryRuntime>();

function resetApiRegistry(runtime: ModelRegistryRuntime): void {
  runtime.apiRegistry.clearApiProviders();
  registerBuiltInApiProviders(runtime.apiRegistry);
  // The Plugin SDK registry is a shipped compatibility facade. Snapshot it at
  // lifecycle publication so request-time routing never depends on mutable global state.
  for (const provider of getPublishedApiProviders()) {
    runtime.apiRegistry.registerApiProvider(provider);
  }
}

/** Creates the runtime facts owned by one model-registry lifecycle. */
export function initializeModelRegistryRuntime(owner: object): void {
  const apiRegistry = createApiRegistry();
  const llmRuntime = createLlmRuntime(apiRegistry);
  const runtime = { apiRegistry, llmRuntime };
  bindStreamLlmRuntime(llmRuntime.streamSimple, llmRuntime);
  resetApiRegistry(runtime);
  modelRegistryRuntimes.set(owner, runtime);
}

/** Returns the prepared runtime facts for one model-registry lifecycle. */
export function getModelRegistryRuntime(owner: object): ModelRegistryRuntime {
  const runtime = modelRegistryRuntimes.get(owner);
  if (!runtime) {
    throw new Error("Model registry runtime is not initialized");
  }
  return runtime;
}

export function resetModelRegistryRuntime(owner: object): void {
  resetApiRegistry(getModelRegistryRuntime(owner));
}
