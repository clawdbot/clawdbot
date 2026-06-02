import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_risk_manager (PROPOSE).
//
// Cluster C "propose" tool per AGENT_ALPHA_TIER_MAP. This tool STAGES a new
// risk-manager proposal; it NEVER creates the risk manager directly. It calls
// the BFF `POST /api/v1/openclaw/stage` endpoint with
// `{ tool_name, workspace_id, params, summary }`. The BFF persists a reviewable
// staged descriptor and returns it; the human reviews + Applies it in the chat.

export const CREATE_RISK_MANAGER_TOOL_NAME = "create_risk_manager";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type CreateRiskManagerDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type CreateRiskManagerParams = {
  name?: string;
  max_concurrent_trades?: number;
  max_margin?: number;
  daily_max_dd_pct?: number;
  max_dd_pct?: number;
  risk_per_trade_pct?: number;
  stop_loss_type?: string;
  venue_ids?: string[];
  intent_brief?: string;
  [key: string]: unknown;
};

function buildSummary(params: CreateRiskManagerParams): string {
  const label =
    typeof params.name === "string" && params.name.length > 0 ? params.name : "risk manager";
  const detail =
    typeof params.intent_brief === "string" && params.intent_brief.length > 0
      ? `: ${params.intent_brief}`
      : "";
  return `Create ${label}${detail}`;
}

export async function runCreateRiskManager(
  params: CreateRiskManagerParams,
  deps: CreateRiskManagerDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: CREATE_RISK_MANAGER_TOOL_NAME,
      workspace_id: process.env.PFM_WORKSPACE_ID,
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a new risk-manager proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-create-risk-manager",
  name: "VC Trader AI Create Risk Manager (Propose)",
  description: "Stages a new risk-manager proposal for human review; never creates directly.",
  tools: (tool) => [
    tool({
      name: CREATE_RISK_MANAGER_TOOL_NAME,
      label: "Create Risk Manager",
      description:
        "Propose a NEW risk manager. This STAGES a proposal for the human to review + Apply in the chat - it does NOT create the risk manager directly. All limit fields are optional; supply the constraints you want enforced.",
      parameters: Type.Object(
        {
          name: Type.Optional(Type.String({ description: "Human-readable risk-manager name." })),
          max_concurrent_trades: Type.Optional(
            Type.Integer({ description: "Maximum concurrent open trades.", minimum: 0 }),
          ),
          max_margin: Type.Optional(
            Type.Number({ description: "Maximum margin usage (account currency).", minimum: 0 }),
          ),
          daily_max_dd_pct: Type.Optional(
            Type.Number({
              description: "Daily max drawdown as a percent (e.g. 5 = 5%).",
              minimum: 0,
            }),
          ),
          max_dd_pct: Type.Optional(
            Type.Number({
              description: "Overall max drawdown as a percent (e.g. 10 = 10%).",
              minimum: 0,
            }),
          ),
          risk_per_trade_pct: Type.Optional(
            Type.Number({ description: "Risk per trade as a percent of equity.", minimum: 0 }),
          ),
          stop_loss_type: Type.Optional(
            Type.String({
              description:
                "Stop-loss type identifier (must match a list_stop_loss_types entry if provided).",
            }),
          ),
          venue_ids: Type.Optional(
            Type.Array(Type.String(), { description: "Venue identifiers this manager governs." }),
          ),
          intent_brief: Type.Optional(
            Type.String({
              description: "One or two sentences describing the risk manager's intent.",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateRiskManager(params as CreateRiskManagerParams, {}, context.signal);
      },
    }),
  ],
});
