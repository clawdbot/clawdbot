import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: position_size_calculator (instrument-aware risk-based sizing).
//
// Calls the workspace-scoped risk/position-size endpoint as the workspace owner
// (PFM_AGENT_TOKEN) to compute instrument-aware risk-based position sizing
// (units/lots/notional) over the real per-instrument economics. This is a POST
// with a JSON body, mirroring the research/fetch template it is derived from.

export const POSITION_SIZE_CALCULATOR_TOOL_NAME = "position_size_calculator";

export type PositionSizeCalculatorDeps = {
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

export type PositionSizeCalculatorParams = {
  symbol: string;
  entry_price: number;
  stop_price: number;
  account_balance: number;
  risk_per_trade_pct: number;
  conviction_multiplier?: number;
  provider?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai position_size_calculator: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runPositionSizeCalculator(
  params: PositionSizeCalculatorParams,
  deps: PositionSizeCalculatorDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const symbol = nonEmpty(params.symbol);
  // Required scalars; the BFF returns 400 otherwise. Guard here so a malformed
  // call fails fast with a clear message instead of a 400.
  if (symbol === undefined) {
    throw new Error("vctraderai position_size_calculator: symbol is required");
  }
  if (typeof params.entry_price !== "number") {
    throw new Error("vctraderai position_size_calculator: entry_price is required (number)");
  }
  if (typeof params.stop_price !== "number") {
    throw new Error("vctraderai position_size_calculator: stop_price is required (number)");
  }
  if (typeof params.account_balance !== "number") {
    throw new Error("vctraderai position_size_calculator: account_balance is required (number)");
  }
  if (typeof params.risk_per_trade_pct !== "number") {
    throw new Error("vctraderai position_size_calculator: risk_per_trade_pct is required (number)");
  }
  // Build the request body from all declared params that are present; omit
  // undefined optionals so the BFF sees only the fields the caller supplied.
  const body: Record<string, unknown> = {
    symbol,
    entry_price: params.entry_price,
    stop_price: params.stop_price,
    account_balance: params.account_balance,
    risk_per_trade_pct: params.risk_per_trade_pct,
  };
  if (typeof params.conviction_multiplier === "number") {
    body.conviction_multiplier = params.conviction_multiplier;
  }
  const provider = nonEmpty(params.provider);
  if (provider !== undefined) {
    body.provider = provider;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/position-size`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-position-size-calculator",
  name: "VC Trader AI Position Size Calculator",
  description:
    "Workspace-scoped tool: instrument-aware risk-based position sizing (units/lots/notional) over the real per-instrument economics, via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN).",
  tools: (tool) => [
    tool({
      name: POSITION_SIZE_CALCULATOR_TOOL_NAME,
      label: "Position Size Calculator",
      description:
        "Instrument-aware risk-based position sizing (units/lots/notional) over the real per-instrument economics. Provide the symbol, entry_price, stop_price, account_balance and risk_per_trade_pct; optionally a conviction_multiplier and a provider. Returns the sized position over the real per-instrument economics for the workspace.",
      parameters: Type.Object({
        symbol: Type.String({
          description: "The instrument symbol to size (e.g. EUR_USD, XAU_USD).",
        }),
        entry_price: Type.Number({
          description: "The intended entry price for the position.",
        }),
        stop_price: Type.Number({
          description: "The stop-loss price used to derive per-unit risk.",
        }),
        account_balance: Type.Number({
          description: "The account balance (account currency) risk is sized against.",
        }),
        risk_per_trade_pct: Type.Number({
          description: "The percentage of account balance to risk on this trade (e.g. 1 for 1%).",
        }),
        conviction_multiplier: Type.Optional(
          Type.Number({
            description:
              "Optional multiplier applied to the base risk for higher-conviction ideas.",
          }),
        ),
        provider: Type.Optional(
          Type.String({
            description: "Optional data/economics provider override for per-instrument economics.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runPositionSizeCalculator(
          params as PositionSizeCalculatorParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
