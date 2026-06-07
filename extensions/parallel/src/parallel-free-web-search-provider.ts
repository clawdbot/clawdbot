import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createParallelFreeWebSearchProviderBase } from "./parallel-free-web-search-provider.shared.js";
import { PARALLEL_FREE_SESSION_ID_MAX_LENGTH } from "./parallel-search-normalize.js";
// Reuse the paid provider's tool schema — both transports accept the same
// objective + search_queries shape — but the free Search MCP caps session_id at
// 100 chars (its `tools/list` schema), tighter than the paid v1 REST limit, so
// the free model-facing schema advertises that tighter bound.
import { ParallelSearchSchema } from "./parallel-web-search-provider.js";

const ParallelFreeSearchSchema = {
  ...ParallelSearchSchema,
  properties: {
    ...ParallelSearchSchema.properties,
    session_id: {
      ...ParallelSearchSchema.properties.session_id,
      maxLength: PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
    },
  },
} satisfies Record<string, unknown>;

type ParallelFreeWebSearchRuntime = typeof import("./parallel-free-web-search-provider.runtime.js");

let parallelFreeWebSearchRuntimePromise: Promise<ParallelFreeWebSearchRuntime> | undefined;

function loadParallelFreeWebSearchRuntime(): Promise<ParallelFreeWebSearchRuntime> {
  parallelFreeWebSearchRuntimePromise ??= import("./parallel-free-web-search-provider.runtime.js");
  return parallelFreeWebSearchRuntimePromise;
}

export function createParallelFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelFreeWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Parallel's free Search MCP (no API key). Returns ranked, LLM-optimized dense excerpts from web sources. Pass an `objective` describing the underlying question along with 2-3 short keyword `search_queries` (Parallel's recommended pairing). For multi-step research, thread the prior result's `sessionId` back in as `session_id` to keep Parallel's context grouped.",
      parameters: ParallelFreeSearchSchema,
      execute: async (args, context) => {
        const { executeParallelFreeWebSearchProviderTool } =
          await loadParallelFreeWebSearchRuntime();
        return await executeParallelFreeWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
