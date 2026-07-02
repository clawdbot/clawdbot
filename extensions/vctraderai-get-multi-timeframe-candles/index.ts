import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_multi_timeframe_candles.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_MULTI_TIMEFRAME_CANDLES_TOOL_NAME = "get_multi_timeframe_candles";

export type GetMultiTimeframeCandlesDeps = {
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

export type GetMultiTimeframeCandlesParams = {
  account_id: string;
  symbol: string;
  timeframes?: string;
  limit_per_tf?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_multi_timeframe_candles: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetMultiTimeframeCandles(
  params: GetMultiTimeframeCandlesParams,
  deps: GetMultiTimeframeCandlesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/candles-mtf`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframes: params.timeframes,
      limit_per_tf: params.limit_per_tf !== undefined ? String(params.limit_per_tf) : "100",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-multi-timeframe-candles",
  name: "VC Trader AI Get Multi-Timeframe Candles",
  description:
    "Read-only workspace-scoped tool: M1/M5/M15/H1 candles for one symbol in a single call, rolled up from the warm M1 feed via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_MULTI_TIMEFRAME_CANDLES_TOOL_NAME,
      label: "Get Multi-Timeframe Candles",
      description:
        "Read M1, M5, M15, and H1 candles for one symbol in a SINGLE call, server-side rolled up from the warm M1 feed (replacing four separate candle round-trips). Required: symbol and account_id. Optional: timeframes (csv subset of 1m,5m,15m,1h; default all four), limit_per_tf (default 100, capped 500). Owner-scoped to the agent's own workspace; every higher-timeframe bar carries m1_count and a complete flag, and a forming or partial bar is labelled partial true, never silently served as complete. A stale or absent symbol returns coverage.on_feed false plus a reason.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read candles for.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to read candles for, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        timeframes: Type.Optional(
          Type.String({ description: "CSV subset of 1m,5m,15m,1h. Default all four." }),
        ),
        limit_per_tf: Type.Optional(
          Type.Integer({ description: "Bars per timeframe.", minimum: 1, maximum: 500 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetMultiTimeframeCandles(
          params as GetMultiTimeframeCandlesParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
