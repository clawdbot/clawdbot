import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentHarness } from "../agents/harness/types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CliHarnessCleanup = {
  harnesses: Map<AgentHarness, () => Promise<void>>;
  registries: Set<PluginRegistry>;
};

// Entry modules must stay runtime-free. Only executable bootstraps grant this scope;
// exported/programmatic CLI calls and Gateway boot retain their existing lifecycle.
const scope = resolveGlobalSingleton<AsyncLocalStorage<"process" | CliHarnessCleanup | undefined>>(
  Symbol.for("openclaw.cliRuntimeCleanup"),
  () => new AsyncLocalStorage(),
);

export function withCliProcessScope<T>(run: () => T): T {
  return scope.run("process", run);
}

export function withCliCommandCleanup<T>(
  gatewayRun: boolean,
  run: (cleanup?: CliHarnessCleanup) => T,
): T {
  if (gatewayRun) {
    // Gateway owns its process lifetime; borrowed calls must not inherit CLI ownership.
    return scope.run(undefined, () => run());
  }
  if (scope.getStore() !== "process") {
    return run();
  }
  const cleanup: CliHarnessCleanup = { harnesses: new Map(), registries: new Set() };
  return scope.run(cleanup, () => run(cleanup));
}

export function retainCliRegistryHarnesses(
  registry: PluginRegistry,
  dispose: (harness: AgentHarness) => Promise<void>,
): void {
  const current = scope.getStore();
  if (!current || current === "process") {
    return;
  }
  for (const { harness } of registry.agentHarnesses) {
    current.registries.add(registry);
    if (!current.harnesses.has(harness)) {
      // Preserve request facts as well as the exact registry binding after helpers unwind.
      current.harnesses.set(
        harness,
        AsyncLocalStorage.bind(() => dispose(harness)),
      );
    }
  }
}
