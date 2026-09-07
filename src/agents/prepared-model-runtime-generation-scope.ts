import { AsyncLocalStorage } from "node:async_hooks";
import {
  runOutsidePluginRegistryResourceScope,
  withPluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { retainPreparedPluginGenerationResources } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeGenerationScope = Readonly<{
  generation: PreparedModelRuntimePluginGeneration;
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined;
}>;

// Global singleton keeps one scope instance across lazy module boundaries so a
// wrapped turn and the nested embedded runner always share the same store.
const PREPARED_MODEL_RUNTIME_PLUGIN_GENERATION_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.preparedModelRuntimePluginGenerationScope",
);

const preparedModelRuntimePluginGenerationScope = resolveGlobalSingleton<
  AsyncLocalStorage<PreparedModelRuntimeGenerationScope | undefined>
>(PREPARED_MODEL_RUNTIME_PLUGIN_GENERATION_SCOPE_KEY, () => new AsyncLocalStorage());

/** Keeps the exact admitted generation available to nested embedded agent runs. */
export async function withPreparedModelRuntimePluginGenerationScope<T>(
  generation: PreparedModelRuntimePluginGeneration,
  run: () => T | Promise<T>,
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined,
): Promise<T> {
  const inherited = preparedModelRuntimePluginGenerationScope.getStore();
  const borrow =
    borrowSnapshot ?? (inherited?.generation === generation ? inherited.borrowSnapshot : undefined);
  const resources = retainPreparedPluginGenerationResources(generation);
  try {
    return await withPluginRegistryResourceScope(resources, () =>
      preparedModelRuntimePluginGenerationScope.run(
        { generation, ...(borrow ? { borrowSnapshot: borrow } : {}) },
        run,
      ),
    );
  } finally {
    resources.release();
  }
}

/** Detached queue drains re-admit on the current generation, never a predecessor's scope. */
export function runOutsidePreparedModelRuntimePluginGenerationScope<T>(run: () => T): T {
  return preparedModelRuntimePluginGenerationScope.exit(() =>
    runOutsidePluginRegistryResourceScope(run),
  );
}

/** Exact admitted generation active for nested prepared model-runtime acquisition. */
export function getPreparedModelRuntimePluginGeneration():
  | PreparedModelRuntimePluginGeneration
  | undefined {
  return preparedModelRuntimePluginGenerationScope.getStore()?.generation;
}

/** Borrows the exact parent snapshot only while its owning turn lease remains open. */
export function getPreparedModelRuntimeBorrowedSnapshot(
  generation: PreparedModelRuntimePluginGeneration,
): PreparedModelRuntimeSnapshot | undefined {
  const current = preparedModelRuntimePluginGenerationScope.getStore();
  return current?.generation === generation ? current.borrowSnapshot?.() : undefined;
}
