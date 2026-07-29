// Memory status collection for status scans.
// Runtime memory dependencies stay lazy so status paths without memory avoid loading the search manager.

import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import {
  resolveSharedMemoryStatusSnapshot,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";

const statusScanDepsRuntimeModuleLoader = createLazyImportLoader(
  () => import("./status.scan.deps.runtime.js"),
);

function loadStatusScanDepsRuntimeModule() {
  return statusScanDepsRuntimeModuleLoader.load();
}

/** Returns the owning agent database path for built-in memory. */
export function resolveDefaultMemoryDatabasePath(agentId: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId });
}

/** Resolves memory index/cache status for the current status scan. */
export async function resolveStatusMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  memoryPlugin: MemoryPluginStatus;
  requireDefaultDatabasePath?: (agentId: string) => string;
}): Promise<MemoryStatusSnapshot | null> {
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  return await resolveSharedMemoryStatusSnapshot({
    cfg: params.cfg,
    agentStatus: params.agentStatus,
    memoryPlugin: params.memoryPlugin,
    resolveMemoryConfig: resolveMemorySearchConfig,
    getMemorySearchManager,
    requireDefaultDatabasePath: params.requireDefaultDatabasePath,
  });
}
