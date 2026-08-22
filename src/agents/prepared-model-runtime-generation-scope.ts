import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

// Global singleton keeps one scope instance across lazy module boundaries so a
// wrapped turn and the nested embedded runner always share the same store.
const PREPARED_MODEL_RUNTIME_PLUGIN_GENERATION_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.preparedModelRuntimePluginGenerationScope",
);

const preparedModelRuntimePluginGenerationScope = resolveGlobalSingleton<
  AsyncLocalStorage<PreparedModelRuntimePluginGeneration | undefined>
>(PREPARED_MODEL_RUNTIME_PLUGIN_GENERATION_SCOPE_KEY, () => new AsyncLocalStorage());

/** Keeps the exact admitted generation available to nested embedded agent runs. */
export function withPreparedModelRuntimePluginGenerationScope<T>(
  generation: PreparedModelRuntimePluginGeneration,
  run: () => T,
): T {
  return preparedModelRuntimePluginGenerationScope.run(generation, run);
}

/** Detached queue drains re-admit on the current generation, never a predecessor's scope. */
export function runOutsidePreparedModelRuntimePluginGenerationScope<T>(run: () => T): T {
  return preparedModelRuntimePluginGenerationScope.exit(run);
}

/** Exact admitted generation active for nested prepared model-runtime acquisition. */
export function getPreparedModelRuntimePluginGeneration():
  | PreparedModelRuntimePluginGeneration
  | undefined {
  return preparedModelRuntimePluginGenerationScope.getStore();
}
