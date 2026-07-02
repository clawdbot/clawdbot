import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_coverage.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/coverage`
// endpoint and returns the raw CoverageEnvelope produced by the
// propfirm_manager `engine.tools.market_data_tools.get_coverage` function
// (instrument, provider, timeframes map -> {files, date_start, date_end}).

export const GET_COVERAGE_TOOL_NAME = "get_coverage";

export type GetCoverageDeps = {
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

export type GetCoverageParams = {
  symbol?: string;
  provider?: string;
  tf?: string;
};

export async function runGetCoverage(
  params: GetCoverageParams,
  deps: GetCoverageDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/coverage`, {
    query: {
      provider: params.provider,
      symbol: params.symbol,
      tf: params.tf,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-coverage",
  name: "VC Trader AI Get Coverage",
  description: "Read-only data coverage report for an instrument across timeframes.",
  tools: (tool) => [
    tool({
      name: GET_COVERAGE_TOOL_NAME,
      label: "Get Coverage",
      description:
        "Report file counts and date ranges per timeframe for an instrument under the configured data root. Filter by provider / symbol / tf (all optional). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        symbol: Type.Optional(
          Type.String({ description: "Instrument symbol (e.g., EUR_USD).", minLength: 1 }),
        ),
        provider: Type.Optional(
          Type.String({ description: "Data provider (e.g., dukascopy).", minLength: 1 }),
        ),
        tf: Type.Optional(
          Type.String({ description: "Timeframe code (e.g., 1H, 4H, 1D).", minLength: 1 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetCoverage(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
