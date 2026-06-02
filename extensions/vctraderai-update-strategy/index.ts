import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: update_strategy (PROPOSE).
//
// Cluster C "propose" tool per AGENT_ALPHA_TIER_MAP. This tool STAGES a
// strategy-update proposal; it NEVER mutates the strategy directly. It calls
// the BFF `POST /api/v1/openclaw/stage` endpoint with
// `{ tool_name, workspace_id, params, summary }`. The BFF persists a reviewable
// staged descriptor and returns it; the human reviews + Applies it in the chat.

export const UPDATE_STRATEGY_TOOL_NAME = "update_strategy";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type UpdateStrategyDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type UpdateStrategyParams = {
  strategy_id: string;
  name?: string;
  default_params?: Record<string, unknown>;
  timeframes?: string[];
  instruments?: string[];
  sessions?: string[];
  indicators?: string[];
  source_text?: string;
  intent_brief?: string;
  [key: string]: unknown;
};

function buildSummary(params: UpdateStrategyParams): string {
  const detail =
    typeof params.intent_brief === "string" && params.intent_brief.length > 0
      ? params.intent_brief
      : (params.name ?? "strategy fields");
  return `Update strategy ${params.strategy_id}: ${detail}`;
}

export async function runUpdateStrategy(
  params: UpdateStrategyParams,
  deps: UpdateStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: UPDATE_STRATEGY_TOOL_NAME,
      workspace_id: process.env.PFM_WORKSPACE_ID,
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a strategy-update proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-update-strategy",
  name: "VC Trader AI Update Strategy (Propose)",
  description: "Stages a strategy-update proposal for human review; never mutates directly.",
  tools: (tool) => [
    tool({
      name: UPDATE_STRATEGY_TOOL_NAME,
      label: "Update Strategy",
      description:
        "Propose an UPDATE to an existing strategy. This STAGES a proposal for the human to review + Apply in the chat - it does NOT mutate the strategy directly. strategy_id is required; supply only the fields you want to change.",
      parameters: Type.Object(
        {
          strategy_id: Type.String({
            description: "Required. Identifier of the strategy to update.",
            minLength: 1,
          }),
          name: Type.Optional(Type.String({ description: "New human-readable strategy name." })),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Replacement default parameters keyed by name.",
            }),
          ),
          timeframes: Type.Optional(
            Type.Array(Type.String(), { description: "Timeframes (e.g. ['M5','H1'])." }),
          ),
          instruments: Type.Optional(
            Type.Array(Type.String(), { description: "Instrument symbols (e.g. ['EUR_USD'])." }),
          ),
          sessions: Type.Optional(
            Type.Array(Type.String(), { description: "Trading sessions (e.g. ['london'])." }),
          ),
          indicators: Type.Optional(
            Type.Array(Type.String(), { description: "Indicator names the strategy uses." }),
          ),
          source_text: Type.Optional(
            Type.String({ description: "Raw natural-language source describing the change." }),
          ),
          intent_brief: Type.Optional(
            Type.String({ description: "One or two sentences describing the intended change." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runUpdateStrategy(params as UpdateStrategyParams, {}, context.signal);
      },
    }),
  ],
});
