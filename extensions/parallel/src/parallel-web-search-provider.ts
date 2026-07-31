import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createParallelWebSearchProviderBase } from "./parallel-web-search-provider.shared.js";

const PARALLEL_MAX_SEARCH_COUNT = 40;
const PARALLEL_MAX_SEARCH_QUERIES = 5;
const PARALLEL_MAX_SEARCH_QUERY_CHARS = 200;
const PARALLEL_MAX_OBJECTIVE_CHARS = 5000;
const PARALLEL_MAX_SESSION_ID_CHARS = 1000;
const PARALLEL_MAX_CLIENT_MODEL_CHARS = 100;

const loadParallelWebSearchRuntime = createLazyRuntimeModule(
  () => import("./parallel-web-search-provider.runtime.js"),
);

// Mirrors Parallel's recommended search tool schema:
// https://docs.parallel.ai/search/best-practices#search-tool-definition
export const ParallelSearchSchema = {
  type: "object",
  properties: {
    objective: {
      type: "string",
      description:
        "Natural-language description of the underlying question or goal driving the search. Should be self-contained with enough context to understand the intent. Used together with search_queries to focus results on the most relevant content.",
      maxLength: PARALLEL_MAX_OBJECTIVE_CHARS,
    },
    search_queries: {
      type: "array",
      description:
        "Concise keyword search queries, 3-6 words each. Provide 2-3 diverse queries for best results (max 5). Vary entity names, synonyms, and angles. Each query is a keyword phrase, not a sentence; do not use site: operators.",
      items: { type: "string", maxLength: PARALLEL_MAX_SEARCH_QUERY_CHARS },
      minItems: 1,
      maxItems: PARALLEL_MAX_SEARCH_QUERIES,
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-40).",
      minimum: 1,
      maximum: PARALLEL_MAX_SEARCH_COUNT,
    },
    session_id: {
      type: "string",
      description:
        "Optional session id returned by an earlier Parallel search. Pass it on follow-up searches that are part of the same task to keep Parallel's server-side context grouped (look for `sessionId` in the prior tool result).",
      maxLength: PARALLEL_MAX_SESSION_ID_CHARS,
    },
    client_model: {
      type: "string",
      description:
        "The identifier of the LLM model making this tool call (e.g. 'claude-opus-4-7', 'gpt-5.6-sol', 'gemini-3.1-pro'). Pass the exact active model slug verbatim; never shorten or substitute a family alias like 'gpt-5'. Lets Parallel tailor default settings for your model's capabilities.",
      maxLength: PARALLEL_MAX_CLIENT_MODEL_CHARS,
    },
  },
  required: ["objective", "search_queries"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createParallelWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Parallel. Returns ranked, LLM-optimized dense excerpts from web sources. Pass an `objective` describing the underlying question along with 2-3 short keyword `search_queries` (Parallel's recommended pairing). For multi-step research, thread the prior result's `sessionId` back in as `session_id` to keep Parallel's context grouped.",
      parameters: ParallelSearchSchema,
      execute: async (args) => {
        const { executeParallelWebSearchProviderTool } = await loadParallelWebSearchRuntime();
        return await executeParallelWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
