import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
export function withPreparedModelRuntimePluginGenerationScope<T>(
  generation: PreparedModelRuntimePluginGeneration,
  run: () => T,
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined,
): T {
  const inherited = preparedModelRuntimePluginGenerationScope.getStore();
  const borrow =
    borrowSnapshot ?? (inherited?.generation === generation ? inherited.borrowSnapshot : undefined);
  return preparedModelRuntimePluginGenerationScope.run(
    { generation, ...(borrow ? { borrowSnapshot: borrow } : {}) },
    run,
  );
}

/** Detached queue drains re-admit on the current generation, never a predecessor's scope. */
export function runOutsidePreparedModelRuntimePluginGenerationScope<T>(run: () => T): T {
  return preparedModelRuntimePluginGenerationScope.exit(run);
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
