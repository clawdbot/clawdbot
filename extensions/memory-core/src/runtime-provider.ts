// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";

export function createMemoryRuntime(
  acquireLocalService?: MemoryCoreAcquireLocalService,
): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(params) {
      const { manager, debug, error } = await getMemorySearchManager({
        ...params,
        ...(acquireLocalService ? { acquireLocalService } : {}),
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
    async closeAllMemorySearchManagers() {
      await closeAllMemorySearchManagers();
    },
    async closeMemorySearchManager(params) {
      await closeMemorySearchManager(params);
    },
  };
}

export const memoryRuntime = createMemoryRuntime();
