import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_price_correlation_snapshot.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_PRICE_CORRELATION_SNAPSHOT_TOOL_NAME = "get_price_correlation_snapshot";

export type GetPriceCorrelationSnapshotDeps = {
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

export type GetPriceCorrelationSnapshotParams = {
  account_id: string;
  symbols?: string;
  timeframe?: string;
  window_bars?: number;
  method?: string;
  min_overlap?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_price_correlation_snapshot: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetPriceCorrelationSnapshot(
  params: GetPriceCorrelationSnapshotParams,
  deps: GetPriceCorrelationSnapshotDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/price-correlation`, {
    query: {
      account_id: params.account_id,
      symbols: params.symbols,
      timeframe: params.timeframe !== undefined ? params.timeframe : "5m",
      window_bars: params.window_bars !== undefined ? String(params.window_bars) : "200",
      method: params.method !== undefined ? params.method : "pearson",
      min_overlap: params.min_overlap !== undefined ? String(params.min_overlap) : "30",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-price-correlation-snapshot",
  name: "VC Trader AI Get Price Correlation Snapshot",
  description:
    "Read-only workspace-scoped tool: cross-instrument return-correlation over aligned warm M1 series via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_PRICE_CORRELATION_SNAPSHOT_TOOL_NAME,
      label: "Get Price Correlation Snapshot",
      description:
        "Compute cross-instrument return-correlation over aligned warm M1 series (DISTINCT from get_correlation_matrix, which is portfolio net-PnL). Required: account_id. Optional: symbols (csv; default is the workspace's live-covered set discovered from the feed), timeframe (default 5m), window_bars (default 200, capped 500), method (pearson default or spearman), min_overlap (default 30). Owner-scoped to the agent's own workspace; the result carries a per-symbol coverage_map and a leg not on the live feed (such as DXY or VIX) is reported off_feed with null matrix cells (cannot_assess), never a zero correlation. A pair below min_overlap or with a constant leg is likewise null; method/window/min_overlap/return_type are echoed so each coefficient is discountable.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to compute correlation for.",
          minLength: 1,
        }),
        symbols: Type.Optional(
          Type.String({ description: "CSV of symbols. Default the workspace live-covered set." }),
        ),
        timeframe: Type.Optional(Type.String({ description: "Roll-up timeframe. Default 5m." })),
        window_bars: Type.Optional(
          Type.Integer({ description: "Correlation window in bars.", minimum: 2, maximum: 500 }),
        ),
        method: Type.Optional(Type.String({ description: "pearson (default) or spearman." })),
        min_overlap: Type.Optional(
          Type.Integer({
            description: "Minimum overlapping bars per pair.",
            minimum: 2,
            maximum: 500,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetPriceCorrelationSnapshot(
          params as GetPriceCorrelationSnapshotParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
