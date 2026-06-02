import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_strategy (PROPOSE).
//
// Cluster C "propose" tool per AGENT_ALPHA_TIER_MAP. This tool STAGES a new
// strategy proposal; it NEVER executes/creates the strategy directly. It calls
// the BFF `POST /api/v1/openclaw/stage` endpoint with
// `{ tool_name, workspace_id, params, summary }`. The BFF persists a reviewable
// staged descriptor and returns it; the human reviews + Applies it in the chat.

export const CREATE_STRATEGY_TOOL_NAME = "create_strategy";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type CreateStrategyDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type CreateStrategyParams = {
  name?: string;
  strategy_type?: string;
  archetype?: string;
  intent_brief: string;
  source_text?: string;
  default_params?: Record<string, unknown>;
  timeframes?: string[];
  instruments?: string[];
  sessions?: string[];
  indicators?: string[];
  [key: string]: unknown;
};

function buildSummary(params: CreateStrategyParams): string {
  const label =
    typeof params.name === "string" && params.name.length > 0 ? params.name : "strategy";
  return `Create ${label}: ${params.intent_brief}`;
}

export async function runCreateStrategy(
  params: CreateStrategyParams,
  deps: CreateStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: CREATE_STRATEGY_TOOL_NAME,
      workspace_id: process.env.PFM_WORKSPACE_ID,
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a new strategy proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-create-strategy",
  name: "VC Trader AI Create Strategy (Propose)",
  description: "Stages a new strategy proposal for human review; never executes directly.",
  tools: (tool) => [
    tool({
      name: CREATE_STRATEGY_TOOL_NAME,
      label: "Create Strategy",
      description:
        "Propose a NEW trading strategy. This STAGES a proposal for the human to review + Apply in the chat - it does NOT create the strategy directly. Provide an intent_brief describing what the strategy should do; other fields are optional hints for the engine.",
      parameters: Type.Object(
        {
          name: Type.Optional(Type.String({ description: "Human-readable strategy name." })),
          strategy_type: Type.Optional(
            Type.String({
              description:
                "Strategy type identifier (must match a list_strategy_types entry if provided).",
            }),
          ),
          archetype: Type.Optional(
            Type.String({ description: "Strategy archetype (e.g. trend, mean-reversion)." }),
          ),
          intent_brief: Type.String({
            description: "Required. One or two sentences describing the strategy's intent.",
            minLength: 1,
          }),
          source_text: Type.Optional(
            Type.String({ description: "Raw natural-language source describing the strategy." }),
          ),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Default strategy parameters keyed by name.",
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
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateStrategy(params as CreateStrategyParams, {}, context.signal);
      },
    }),
  ],
});
