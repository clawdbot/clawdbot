import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: detect_support_resistance.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const DETECT_SUPPORT_RESISTANCE_TOOL_NAME = "detect_support_resistance";

export type DetectSupportResistanceDeps = {
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

export type DetectSupportResistanceParams = {
  account_id: string;
  symbol: string;
  timeframe?: string;
  lookback?: number;
  fractal_n?: number;
  include_volume_nodes?: boolean;
  n_volume_bins?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai detect_support_resistance: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runDetectSupportResistance(
  params: DetectSupportResistanceParams,
  deps: DetectSupportResistanceDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/support-resistance`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframe: params.timeframe !== undefined ? params.timeframe : "5m",
      lookback: params.lookback !== undefined ? String(params.lookback) : "200",
      fractal_n: params.fractal_n !== undefined ? String(params.fractal_n) : "2",
      include_volume_nodes:
        params.include_volume_nodes !== undefined ? String(params.include_volume_nodes) : "true",
      n_volume_bins: params.n_volume_bins !== undefined ? String(params.n_volume_bins) : "24",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-detect-support-resistance",
  name: "VC Trader AI Detect Support/Resistance",
  description:
    "Read-only workspace-scoped tool: support/resistance levels over the warm M1 feed via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: DETECT_SUPPORT_RESISTANCE_TOOL_NAME,
      label: "Detect Support/Resistance",
      description:
        "Detect support/resistance levels — swing fractals, lookback-range pivots, and price-binned volume nodes — over the warm M1 feed rolled up to the requested timeframe. Required: symbol and account_id. Optional: timeframe (default 5m), lookback (default 200, capped 500), fractal_n (swing strength, default 2), include_volume_nodes (default true), n_volume_bins (default 24). Owner-scoped to the agent's own workspace. The pivot levels are lookback-range-derived (NOT classic session pivots) and systematically wider; every volume-node level is flagged approximate_volume true because CFD volume is tick-volume, and the full parameter set is echoed so the level set is reproducible and the touch-count strength is discountable. A stale or absent symbol returns empty levels with coverage.on_feed false plus a reason.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to compute levels for.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to compute levels for, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        timeframe: Type.Optional(Type.String({ description: "Roll-up timeframe. Default 5m." })),
        lookback: Type.Optional(
          Type.Integer({ description: "Bars to scan.", minimum: 2, maximum: 500 }),
        ),
        fractal_n: Type.Optional(
          Type.Integer({ description: "Swing strength.", minimum: 1, maximum: 10 }),
        ),
        include_volume_nodes: Type.Optional(
          Type.Boolean({ description: "Include price-binned volume nodes. Default true." }),
        ),
        n_volume_bins: Type.Optional(
          Type.Integer({ description: "Number of volume bins.", minimum: 1, maximum: 200 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDetectSupportResistance(
          params as DetectSupportResistanceParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
