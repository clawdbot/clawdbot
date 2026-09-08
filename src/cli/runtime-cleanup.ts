import type { CliHarnessCleanup } from "./runtime-cleanup-scope.js";

// Match Gateway's harness/MCP shutdown grace; local-provider TERM/KILL already
// consumes at most two 2-second waits. Keep command teardown bounded independently.
const DISPOSER_TIMEOUT_MS = 5_000;
const pendingDisposers = new Map<symbol, string>();

export function getPendingCliDisposers(): string[] {
  return [...pendingDisposers.values()];
}

export async function runCliDisposer(name: string, dispose: () => Promise<void>): Promise<void> {
  const token = Symbol(name);
  pendingDisposers.set(token, name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve()
    .then(dispose)
    .finally(() => pendingDisposers.delete(token));
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`CLI cleanup timed out: ${name} after ${DISPOSER_TIMEOUT_MS}ms`);
          resolve();
        }, DISPOSER_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Teardown cannot mask the command outcome or skip later resources.
  } finally {
    clearTimeout(timer);
  }
}

export async function closeCliResources(cleanup?: CliHarnessCleanup): Promise<void> {
  const finalizers: Record<string, () => Promise<void>> = {
    "agent-harnesses": async () => {
      const { listRegisteredAgentHarnesses, disposeRegisteredAgentHarnesses } =
        await import("../agents/harness/registry.js");
      const registered = listRegisteredAgentHarnesses();
      if (!cleanup) {
        if (registered.length > 0) {
          await disposeRegisteredAgentHarnesses();
        }
        return;
      }
      const { markPluginRegistryRetired } = await import("../plugins/registry-lifecycle.js");
      try {
        await Promise.all(
          [...cleanup.harnesses].map(([harness, dispose]) =>
            runCliDisposer(`agent-harness/${harness.id}`, dispose),
          ),
        );
      } finally {
        // Loader caches outlive operation metadata. Retire only registries used by
        // this terminal process command so their disposed harnesses cannot be reused.
        for (const registry of cleanup.registries) {
          markPluginRegistryRetired(registry);
        }
        cleanup.harnesses.clear();
        cleanup.registries.clear();
      }
    },
    "provider-local-services": async () => {
      const { hasManagedProviderLocalServices } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasManagedProviderLocalServices()) {
        const { stopManagedProviderLocalServices } =
          await import("../agents/provider-local-service.js");
        await stopManagedProviderLocalServices();
      }
    },
    "provider-transport-dispatchers": async () => {
      const { hasProviderTransportDispatcherPool } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasProviderTransportDispatcherPool()) {
        const { closeProviderTransportDispatcherPool } =
          await import("../agents/provider-transport-dispatcher-pool.js");
        await closeProviderTransportDispatcherPool();
      }
    },
    "mcp-loopback": async () => {
      const { getActiveMcpLoopbackRuntime } =
        await import("../gateway/mcp-http.loopback-runtime.js");
      if (getActiveMcpLoopbackRuntime()) {
        const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
        await closeMcpLoopbackServer();
      }
    },
    memory: async () => {
      const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
      if (hasMemoryRuntime()) {
        const { closeActiveMemorySearchManagersCore } =
          await import("../plugins/memory-runtime.js");
        await closeActiveMemorySearchManagersCore();
      }
    },
  };
  for (const [name, finalize] of Object.entries(finalizers)) {
    await runCliDisposer(name, finalize);
  }
}
