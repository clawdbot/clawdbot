import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: latest_ohlcv_file.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/ohlcv/latest`
// endpoint and returns the raw envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.latest_ohlcv_file` function (path, sources,
// filters).

export const LATEST_OHLCV_FILE_TOOL_NAME = "latest_ohlcv_file";

export type LatestOhlcvFileDeps = {
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

export type LatestOhlcvFileParams = {
  symbol: string;
  tf: string;
  provider?: string;
};

export async function runLatestOhlcvFile(
  params: LatestOhlcvFileParams,
  deps: LatestOhlcvFileDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/ohlcv/latest`, {
    query: {
      symbol: params.symbol,
      tf: params.tf,
      provider: params.provider,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-latest-ohlcv-file",
  name: "VC Trader AI Latest OHLCV File",
  description: "Read-only locator for the most recent OHLCV parquet file.",
  tools: (tool) => [
    tool({
      name: LATEST_OHLCV_FILE_TOOL_NAME,
      label: "Latest OHLCV File",
      description:
        "Locate the most recently modified OHLCV parquet file for the given symbol + timeframe (provider optional). Returns the parquet path. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Instrument symbol (e.g., EUR_USD).", minLength: 1 }),
        tf: Type.String({ description: "Timeframe code (e.g., 1H, 4H, 1D).", minLength: 1 }),
        provider: Type.Optional(
          Type.String({ description: "Data provider (e.g., dukascopy).", minLength: 1 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runLatestOhlcvFile(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
