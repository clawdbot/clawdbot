import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_atr.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_ATR_TOOL_NAME = "get_atr";

export type GetAtrDeps = {
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

export type GetAtrParams = {
  account_id: string;
  symbol: string;
  period?: number;
  timeframe?: string;
  method?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_atr: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetAtr(
  params: GetAtrParams,
  deps: GetAtrDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/atr`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      period: params.period !== undefined ? String(params.period) : "14",
      timeframe: params.timeframe !== undefined ? params.timeframe : "1m",
      method: params.method !== undefined ? params.method : "wilder",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-atr",
  name: "VC Trader AI Get ATR",
  description:
    "Read-only workspace-scoped tool: ATR(period) plus a volatility-state label over the warm M1 feed via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_ATR_TOOL_NAME,
      label: "Get ATR",
      description:
        "Compute ATR(period) plus a parameterised volatility-state label over the warm M1 feed (rolled up to the requested timeframe) for dynamic stops and sizing. Required: symbol and account_id. Optional: period (default 14), timeframe (one of 1m, 5m, 15m, 1h; default 1m), method (wilder default or sma). Owner-scoped to the agent's own workspace; the result echoes its full parameter set so you can discount the label, and carries per-symbol coverage. A stale or absent symbol returns atr null with coverage.on_feed false (cannot_assess), never a calm zero.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to compute ATR for.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to compute ATR for, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        period: Type.Optional(
          Type.Integer({ description: "ATR lookback period.", minimum: 1, maximum: 500 }),
        ),
        timeframe: Type.Optional(
          Type.String({ description: "Roll-up timeframe: one of 1m, 5m, 15m, 1h. Default 1m." }),
        ),
        method: Type.Optional(Type.String({ description: "ATR method: wilder (default) or sma." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetAtr(params as GetAtrParams, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
