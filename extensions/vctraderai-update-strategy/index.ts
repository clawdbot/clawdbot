import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: update_strategy (DIRECT_CONTROL, WS-C PR B).
//
// Cluster-C registry tool. FLIPPED from PROPOSE_ONLY (staged card) to
// DIRECT_CONTROL: this tool UPDATES the strategy directly. It calls the guarded
// internal BFF route `POST /api/v1/openclaw/registry/update-strategy` with the
// shared OPENCLAW_GATEWAY_TOKEN plus `X-OpenClaw-Tool` so the server-side
// allowlist gates the exact tool. owner_user_id is resolved SERVER-SIDE from the
// trusted workspace (never sent by this plugin); authoring only (no deploy).

export const UPDATE_STRATEGY_TOOL_NAME = "update_strategy";
const REGISTRY_PATH = "/api/v1/openclaw/registry/update-strategy";

export type UpdateStrategyDeps = {
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

export async function runUpdateStrategy(
  params: UpdateStrategyParams,
  deps: UpdateStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(REGISTRY_PATH, {
    method: "POST",
    body: params,
    headers: { "X-OpenClaw-Tool": UPDATE_STRATEGY_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-update-strategy",
  name: "VC Trader AI Update Strategy",
  description:
    "Updates an existing strategy directly (owner-scoped); does not deploy or touch live money.",
  tools: (tool) => [
    tool({
      name: UPDATE_STRATEGY_TOOL_NAME,
      label: "Update Strategy",
      description:
        "UPDATE an existing strategy. This mutates it directly (owner-scoped to your workspace) - it does NOT run a backtest, deploy, or touch live money. strategy_id is required; supply only the fields you want to change.",
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
        return runUpdateStrategy(
          params as UpdateStrategyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
