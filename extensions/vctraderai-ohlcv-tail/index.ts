import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: ohlcv_tail.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/ohlcv/tail`
// endpoint and returns the raw envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.ohlcv_tail` function (path, rows, schema,
// source, filters).

export const OHLCV_TAIL_TOOL_NAME = "ohlcv_tail";

export type OhlcvTailDeps = {
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

export type OhlcvTailParams = {
  symbol: string;
  tf: string;
  n: number;
  provider?: string;
};

export async function runOhlcvTail(
  params: OhlcvTailParams,
  deps: OhlcvTailDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/ohlcv/tail`, {
    query: {
      symbol: params.symbol,
      tf: params.tf,
      n: String(params.n),
      provider: params.provider,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-ohlcv-tail",
  name: "VC Trader AI OHLCV Tail",
  description: "Read-only bounded OHLCV tail rows for a symbol + timeframe.",
  tools: (tool) => [
    tool({
      name: OHLCV_TAIL_TOOL_NAME,
      label: "OHLCV Tail",
      description:
        "Return the last N OHLCV bars for the given symbol + timeframe (provider optional). Locates the latest parquet, reads the tail rows, returns rows + schema. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Instrument symbol (e.g., EUR_USD).", minLength: 1 }),
        tf: Type.String({ description: "Timeframe code (e.g., 1H, 4H, 1D).", minLength: 1 }),
        n: Type.Integer({
          description: "Number of tail bars to return (bounded server-side).",
          minimum: 1,
          maximum: 500,
        }),
        provider: Type.Optional(
          Type.String({ description: "Data provider (e.g., dukascopy).", minLength: 1 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runOhlcvTail(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
