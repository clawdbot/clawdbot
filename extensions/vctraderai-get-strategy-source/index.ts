import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_strategy_source.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/strategies/${strategy_id}/source` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_strategy_source` function.

export const GET_STRATEGY_SOURCE_TOOL_NAME = "get_strategy_source";

export type GetStrategySourceDeps = {
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

export type GetStrategySourceParams = {
  strategy_id: string;
};

export async function runGetStrategySource(
  params: GetStrategySourceParams,
  deps: GetStrategySourceDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/strategies/${encodeURIComponent(params.strategy_id)}/source`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-strategy-source",
  name: "VC Trader AI Get Strategy Source",
  description: "Read-only catalogue source for a strategy.",
  tools: (tool) => [
    tool({
      name: GET_STRATEGY_SOURCE_TOOL_NAME,
      label: "Get Strategy Source",
      description:
        "Return the source artefact for a single strategy (code / config / DSL) from the propfirm_manager catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        strategy_id: Type.String({
          description: "Strategy identifier (UUID or short slug).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetStrategySource(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
