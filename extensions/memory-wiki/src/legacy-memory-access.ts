import { isLegacyMemorySurfaceDisabled } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfiguredAgentIds, type ResolvedMemoryWikiConfig } from "./config.js";

export const LEGACY_MEMORY_WIKI_UNAVAILABLE =
  "Memory Wiki is unavailable after scoped-memory cutover.";

/**
 * Phase 1C has no operator access context for raw vault I/O. A global vault is
 * shared legacy state, so any cut-over owner makes the whole route unavailable.
 */
export function assertLegacyMemoryWikiAccessAvailable(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
}): void {
  const agentIds =
    params.config.vault.scope === "agent" && params.agentId
      ? [params.agentId]
      : resolveMemoryWikiConfiguredAgentIds(params.appConfig);
  if (agentIds.some(isLegacyMemorySurfaceDisabled)) {
    throw new Error(LEGACY_MEMORY_WIKI_UNAVAILABLE);
  }
}
