import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_indicator (PROPOSE).
//
// Cluster C "propose" tool per AGENT_ALPHA_TIER_MAP. This tool STAGES a new
// indicator proposal; it NEVER creates the indicator directly. It calls the BFF
// `POST /api/v1/openclaw/stage` endpoint with
// `{ tool_name, workspace_id, params, summary }`. The BFF persists a reviewable
// staged descriptor and returns it; the human reviews + Applies it in the chat.

export const CREATE_INDICATOR_TOOL_NAME = "create_indicator";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type CreateIndicatorDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type CreateIndicatorParams = {
  name?: string;
  indicator_type?: string;
  indicator_family?: string;
  default_params?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  source_text?: string;
  intent_brief: string;
  [key: string]: unknown;
};

function buildSummary(params: CreateIndicatorParams): string {
  const label =
    typeof params.name === "string" && params.name.length > 0 ? params.name : "indicator";
  return `Create ${label}: ${params.intent_brief}`;
}

export async function runCreateIndicator(
  params: CreateIndicatorParams,
  deps: CreateIndicatorDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: CREATE_INDICATOR_TOOL_NAME,
      workspace_id: process.env.PFM_WORKSPACE_ID,
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a new indicator proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-create-indicator",
  name: "VC Trader AI Create Indicator (Propose)",
  description: "Stages a new indicator proposal for human review; never creates directly.",
  tools: (tool) => [
    tool({
      name: CREATE_INDICATOR_TOOL_NAME,
      label: "Create Indicator",
      description:
        "Propose a NEW indicator. This STAGES a proposal for the human to review + Apply in the chat - it does NOT create the indicator directly. Provide an intent_brief describing what the indicator computes; other fields are optional hints for the engine.",
      parameters: Type.Object(
        {
          name: Type.Optional(Type.String({ description: "Human-readable indicator name." })),
          indicator_type: Type.Optional(
            Type.String({
              description:
                "Indicator type identifier (must match a list_indicator_types entry if provided).",
            }),
          ),
          indicator_family: Type.Optional(
            Type.String({ description: "Indicator family (e.g. momentum, volatility)." }),
          ),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Default indicator parameters keyed by name.",
            }),
          ),
          output_schema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Declared output schema for the indicator's series.",
            }),
          ),
          source_text: Type.Optional(
            Type.String({ description: "Raw natural-language source describing the indicator." }),
          ),
          intent_brief: Type.String({
            description: "Required. One or two sentences describing the indicator's intent.",
            minLength: 1,
          }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateIndicator(params as CreateIndicatorParams, {}, context.signal);
      },
    }),
  ],
});
