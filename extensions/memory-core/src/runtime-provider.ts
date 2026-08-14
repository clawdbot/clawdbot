// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { configureMemoryCoreDreamingState } from "./dreaming-state.js";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";

export function createMemoryRuntime(host: MemoryCoreRuntimeHost = {}): MemoryPluginRuntime {
  if (host.openKeyedStore) {
    configureMemoryCoreDreamingState(host.openKeyedStore);
  }

  return {
    async getMemorySearchManager(params) {
      const { manager, debug, error } = await getMemorySearchManager({
        ...params,
        ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
      });
      return {
        manager,
        debug,
        error,
      };
    },
    resolveMemoryBackendConfig(params) {
      return resolveMemoryBackendConfig(params);
    },
    async authorizeSearchHits(params) {
      const { filterMemorySearchHitsBySessionVisibility } =
        await import("./session-search-visibility.js");
      return await filterMemorySearchHitsBySessionVisibility(params);
    },
    async closeAllMemorySearchManagers() {
      await closeAllMemorySearchManagers();
    },
    async closeMemorySearchManager(params) {
      await closeMemorySearchManager(params);
    },
  };
}

export const memoryRuntime = createMemoryRuntime();
