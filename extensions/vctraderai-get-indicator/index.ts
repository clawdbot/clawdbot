import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_indicator.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/indicators/${indicator_id}` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_indicator` function.

export const GET_INDICATOR_TOOL_NAME = "get_indicator";

export type GetIndicatorDeps = {
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

export type GetIndicatorParams = {
  indicator_id: string;
};

export async function runGetIndicator(
  params: GetIndicatorParams,
  deps: GetIndicatorDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/indicators/${encodeURIComponent(params.indicator_id)}`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-indicator",
  name: "VC Trader AI Get Indicator",
  description: "Read-only catalogue lookup of a single indicator.",
  tools: (tool) => [
    tool({
      name: GET_INDICATOR_TOOL_NAME,
      label: "Get Indicator",
      description:
        "Return a single indicator row from the propfirm_manager core.indicators catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        indicator_id: Type.String({
          description: "Indicator identifier (UUID or short slug).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetIndicator(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
