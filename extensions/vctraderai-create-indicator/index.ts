import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_indicator (DIRECT_CONTROL, WS-C PR B).
//
// Cluster-C registry tool. FLIPPED from PROPOSE_ONLY (staged card) to
// DIRECT_CONTROL: this tool CREATES the indicator directly -- it authors Python +
// an indicator manifest, validates, and persists it immediately. It calls the
// guarded internal BFF route `POST /api/v1/openclaw/registry/create-indicator`
// with the shared OPENCLAW_GATEWAY_TOKEN plus `X-OpenClaw-Tool` so the
// server-side allowlist gates the exact tool. owner_user_id is resolved
// SERVER-SIDE from the trusted workspace (never sent by this plugin).

export const CREATE_INDICATOR_TOOL_NAME = "create_indicator";
const REGISTRY_PATH = "/api/v1/openclaw/registry/create-indicator";

export type CreateIndicatorDeps = {
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

export type CreateIndicatorParams = {
  name?: string;
  indicator_type?: string;
  indicator_family?: string;
  default_params?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  /** Complete agent-authored Python; the BFF assigns source provenance. */
  source_text: string;
  intent_brief?: string;
  [key: string]: unknown;
};

export async function runCreateIndicator(
  params: CreateIndicatorParams,
  deps: CreateIndicatorDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(REGISTRY_PATH, {
    method: "POST",
    body: params,
    headers: { "X-OpenClaw-Tool": CREATE_INDICATOR_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-create-indicator",
  name: "VC Trader AI Create Indicator",
  description:
    "Creates a directly authored Python indicator, validated and persisted owner-scoped; no second authoring model.",
  tools: (tool) => [
    tool({
      name: CREATE_INDICATOR_TOOL_NAME,
      label: "Create Indicator",
      description:
        "Create a NEW indicator directly. Always provide complete native-Python source_text with compute(...), then lint before create. The deterministic validator persists the source only after AST, contract, smoke, and capability checks; this does not run a backtest or touch live money.",
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
          source_text: Type.String({
            description: "Required complete native-Python source with compute(data, params=None).",
            minLength: 1,
          }),
          intent_brief: Type.Optional(
            Type.String({ description: "Optional concise intent metadata for the indicator." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateIndicator(
          params as CreateIndicatorParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
