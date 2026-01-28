import type { MoltbotConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./manager.js";

export type MemorySearchManagerResult = {
  manager: MemoryIndexManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: MoltbotConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}
