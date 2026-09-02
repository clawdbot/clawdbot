import type { CliHarnessCleanup } from "./runtime-cleanup-scope.js";

export async function closeCliResources(cleanup?: CliHarnessCleanup): Promise<void> {
  const finalizers = [
    async () => {
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
        await Promise.allSettled([...cleanup.harnesses.values()].map((dispose) => dispose()));
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
    async () => {
      const { hasManagedProviderLocalServices } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasManagedProviderLocalServices()) {
        const { stopManagedProviderLocalServices } =
          await import("../agents/provider-local-service.js");
        await stopManagedProviderLocalServices();
      }
    },
    async () => {
      const { hasProviderTransportDispatcherPool } =
        await import("../agents/provider-runtime-lifecycle.js");
      if (hasProviderTransportDispatcherPool()) {
        const { closeProviderTransportDispatcherPool } =
          await import("../agents/provider-transport-dispatcher-pool.js");
        await closeProviderTransportDispatcherPool();
      }
    },
    async () => {
      const { getActiveMcpLoopbackRuntime } =
        await import("../gateway/mcp-http.loopback-runtime.js");
      if (getActiveMcpLoopbackRuntime()) {
        const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
        await closeMcpLoopbackServer();
      }
    },
    async () => {
      const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
      if (hasMemoryRuntime()) {
        const { closeActiveMemorySearchManagersCore } =
          await import("../plugins/memory-runtime.js");
        await closeActiveMemorySearchManagersCore();
      }
    },
  ];
  // Teardown is sequential and best-effort so one stale lazy chunk or plugin
  // failure cannot mask the CLI command's result or skip later resources.
  for (const finalize of finalizers) {
    await finalize().catch(() => undefined);
  }
}
