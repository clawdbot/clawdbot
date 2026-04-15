import type { OpenClawConfig } from "./memory-core-host-engine-foundation.js";
import type { MemorySearchManagerResult } from "../memory/search-manager.js";
import { getMemorySearchManager } from "../memory/search-manager.js";

export type { MemorySearchManagerResult };

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  return await getMemorySearchManager(params);
}
