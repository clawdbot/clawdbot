import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: detect_candlestick_patterns.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const DETECT_CANDLESTICK_PATTERNS_TOOL_NAME = "detect_candlestick_patterns";

export type DetectCandlestickPatternsDeps = {
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

export type DetectCandlestickPatternsParams = {
  account_id: string;
  symbol: string;
  timeframe?: string;
  lookback?: number;
  patterns?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai detect_candlestick_patterns: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runDetectCandlestickPatterns(
  params: DetectCandlestickPatternsParams,
  deps: DetectCandlestickPatternsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/patterns`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframe: params.timeframe !== undefined ? params.timeframe : "1m",
      lookback: params.lookback !== undefined ? String(params.lookback) : "50",
      patterns: params.patterns,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-detect-candlestick-patterns",
  name: "VC Trader AI Detect Candlestick Patterns",
  description:
    "Read-only workspace-scoped tool: pure-compute candlestick patterns over the warm M1 feed via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: DETECT_CANDLESTICK_PATTERNS_TOOL_NAME,
      label: "Detect Candlestick Patterns",
      description:
        "Detect candlestick patterns (hammer, inverted_hammer, bullish_engulfing, bearish_engulfing, doji, inside_bar, pin_bar) by pure compute over the warm M1 feed rolled up to the requested timeframe. Required: symbol and account_id. Optional: timeframe (default 1m), lookback (bars to scan, default 50, capped 200), patterns (csv subset; default all). Owner-scoped to the agent's own workspace; each detection returns raw geometric ratios instead of a graded label, and the full threshold set is echoed in params so every pattern is reproducible and discountable. A stale or absent symbol returns empty detections with coverage.on_feed false plus a reason, never silent.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to scan for patterns.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to scan, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        timeframe: Type.Optional(Type.String({ description: "Roll-up timeframe. Default 1m." })),
        lookback: Type.Optional(
          Type.Integer({ description: "Bars to scan.", minimum: 2, maximum: 200 }),
        ),
        patterns: Type.Optional(
          Type.String({ description: "CSV subset of pattern names. Default all." }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDetectCandlestickPatterns(
          params as DetectCandlestickPatternsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
