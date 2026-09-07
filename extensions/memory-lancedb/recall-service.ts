import { MemoryRecallEmbeddingError, runWithTimeout } from "./embeddings.js";
import type { MemorySearchResult } from "./lancedb-store.js";

/** Run embedding and search under one deadline; callers retain cooldown and result policy. */
export function startMemoryRecall(params: {
  timeoutMs: number;
  /** Read the remaining budget after caller-side query preparation, just before dispatch. */
  embed: (timeoutMs: () => number) => Promise<number[]>;
  search: (vector: number[], timeoutMs: number) => Promise<MemorySearchResult[]>;
  beforeSearch?: () => void;
}) {
  let phase: "embedding" | "search" = "embedding";
  const result = runWithTimeout({
    timeoutMs: params.timeoutMs,
    task: async (deadlineAtMs) => {
      let vector: number[];
      try {
        vector = await params.embed(() => Math.max(1, deadlineAtMs - Date.now()));
      } catch (error) {
        throw new MemoryRecallEmbeddingError(error);
      }
      params.beforeSearch?.();
      phase = "search";
      return await params.search(vector, Math.max(0, deadlineAtMs - Date.now()));
    },
  });
  return {
    result,
    // Read the live phase after the caller's post-await authority check.
    get phase(): "embedding" | "search" {
      return phase;
    },
  };
}
