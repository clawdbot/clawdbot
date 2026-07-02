import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_timeframes.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/timeframes` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_timeframes` function.

export const LIST_TIMEFRAMES_TOOL_NAME = "list_timeframes";

export type ListTimeframesDeps = {
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

export type ListTimeframesParams = {
  limit?: number;
};

export async function runListTimeframes(
  params: ListTimeframesParams,
  deps: ListTimeframesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/timeframes`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-timeframes",
  name: "VC Trader AI List Timeframes",
  description: "Read-only catalogue listing of timeframes.",
  tools: (tool) => [
    tool({
      name: LIST_TIMEFRAMES_TOOL_NAME,
      label: "List Timeframes",
      description:
        "List timeframes from the propfirm_manager core.timeframes catalogue (timeframe_id, code, seconds). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum rows to return (1..1000, default 200).",
            minimum: 1,
            maximum: 1000,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListTimeframes(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
