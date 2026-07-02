import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_indicator_source.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/indicators/${indicator_id}/source` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_indicator_source` function.

export const GET_INDICATOR_SOURCE_TOOL_NAME = "get_indicator_source";

export type GetIndicatorSourceDeps = {
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

export type GetIndicatorSourceParams = {
  indicator_id: string;
};

export async function runGetIndicatorSource(
  params: GetIndicatorSourceParams,
  deps: GetIndicatorSourceDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/indicators/${encodeURIComponent(params.indicator_id)}/source`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-indicator-source",
  name: "VC Trader AI Get Indicator Source",
  description: "Read-only catalogue source for an indicator.",
  tools: (tool) => [
    tool({
      name: GET_INDICATOR_SOURCE_TOOL_NAME,
      label: "Get Indicator Source",
      description:
        "Return the source artefact for a single indicator from the propfirm_manager catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        indicator_id: Type.String({
          description: "Indicator identifier (UUID or short slug).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetIndicatorSource(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
