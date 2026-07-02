import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_strategy_types.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/strategy-types` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_strategy_types` function.

export const LIST_STRATEGY_TYPES_TOOL_NAME = "list_strategy_types";

export type ListStrategyTypesDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export async function runListStrategyTypes(
  deps: ListStrategyTypesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/strategy-types`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-strategy-types",
  name: "VC Trader AI List Strategy Types",
  description: "Read-only catalogue listing of strategy types.",
  tools: (tool) => [
    tool({
      name: LIST_STRATEGY_TYPES_TOOL_NAME,
      label: "List Strategy Types",
      description:
        "List strategy types from the propfirm_manager core.strategy_types catalogue (strategy_type_id, name). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runListStrategyTypes({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
