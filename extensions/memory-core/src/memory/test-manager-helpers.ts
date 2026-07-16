import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryIndexManager } from "./index.js";

type MemoryIndexModule = typeof import("./index.js");

let ensureEmbeddingMocksLoadedPromise: Promise<void> | null = null;
let getMemorySearchManagerPromise: Promise<MemoryIndexModule["getMemorySearchManager"]> | null =
  null;

async function ensureEmbeddingMocksLoaded(): Promise<void> {
  ensureEmbeddingMocksLoadedPromise ??= import("./embedding.test-mocks.js").then(() => undefined);
  await ensureEmbeddingMocksLoadedPromise;
}

async function loadGetMemorySearchManager(): Promise<MemoryIndexModule["getMemorySearchManager"]> {
  getMemorySearchManagerPromise ??= import("./index.js").then((mod) => mod.getMemorySearchManager);
  return await getMemorySearchManagerPromise;
}

export async function getRequiredMemoryIndexManager(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager> {
  await ensureEmbeddingMocksLoaded();
  const getMemorySearchManager = await loadGetMemorySearchManager();
  const result = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId ?? "main",
    purpose: params.purpose,
  });
  if (!result.manager) {
    throw new Error("manager missing");
  }
  if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
    throw new Error("manager does not support sync");
  }
  return result.manager as unknown as MemoryIndexManager;
}
