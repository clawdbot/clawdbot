import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: classify_regime.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const CLASSIFY_REGIME_TOOL_NAME = "classify_regime";

export type ClassifyRegimeDeps = {
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

export type ClassifyRegimeParams = {
  account_id: string;
  symbol: string;
  timeframe?: string;
  adx_period?: number;
  atr_period?: number;
  lookback?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai classify_regime: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runClassifyRegime(
  params: ClassifyRegimeParams,
  deps: ClassifyRegimeDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/regime`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframe: params.timeframe !== undefined ? params.timeframe : "15m",
      adx_period: params.adx_period !== undefined ? String(params.adx_period) : "14",
      atr_period: params.atr_period !== undefined ? String(params.atr_period) : "14",
      lookback: params.lookback !== undefined ? String(params.lookback) : "200",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-classify-regime",
  name: "VC Trader AI Classify Regime",
  description:
    "Read-only workspace-scoped tool: market-regime classification via ADX+ATR over the warm M1 feed via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: CLASSIFY_REGIME_TOOL_NAME,
      label: "Classify Regime",
      description:
        "Classify the market regime (trending, ranging, choppy, or insufficient_data) via Wilder ADX and ATR% over the warm M1 feed rolled up to the requested timeframe. Required: symbol and account_id. Optional: timeframe (default 15m), adx_period and atr_period (default 14), lookback (default 200, capped 500). Owner-scoped to the agent's own workspace; the ADX/ATR cut points are echoed in params so trending is reproducible and discountable. Too few complete bars, or a stale/absent symbol, returns regime insufficient_data with coverage.on_feed false — never a false ranging / all-calm.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to classify regime for.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to classify, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        timeframe: Type.Optional(Type.String({ description: "Roll-up timeframe. Default 15m." })),
        adx_period: Type.Optional(
          Type.Integer({ description: "ADX period.", minimum: 2, maximum: 200 }),
        ),
        atr_period: Type.Optional(
          Type.Integer({ description: "ATR period.", minimum: 1, maximum: 200 }),
        ),
        lookback: Type.Optional(
          Type.Integer({ description: "Bars to scan.", minimum: 2, maximum: 500 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runClassifyRegime(
          params as ClassifyRegimeParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
