import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_strategy (DIRECT_CONTROL, WS-C PR B).
//
// Cluster-C registry tool. FLIPPED from PROPOSE_ONLY (staged card) to
// DIRECT_CONTROL: this tool CREATES the strategy directly -- it authors Python +
// a manifest, validates, and persists the strategy + registry pointer
// immediately. It calls the guarded internal BFF route
// `POST /api/v1/openclaw/registry/create-strategy` with the shared
// OPENCLAW_GATEWAY_TOKEN plus `X-OpenClaw-Tool` so the server-side allowlist gates
// the exact tool. owner_user_id is resolved SERVER-SIDE from the trusted
// workspace (never sent by this plugin); this is authoring only (no backtest,
// deploy, or live-money action).

export const CREATE_STRATEGY_TOOL_NAME = "create_strategy";
const REGISTRY_PATH = "/api/v1/openclaw/registry/create-strategy";

export type CreateStrategyDeps = {
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

export async function runCreateStrategy(
  params: CreateStrategyParams,
  deps: CreateStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(REGISTRY_PATH, {
    method: "POST",
    body: params,
    headers: { "X-OpenClaw-Tool": CREATE_STRATEGY_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-create-strategy",
  name: "VC Trader AI Create Strategy",
  description:
    "Creates a new strategy directly (authors + persists a research artifact + registry pointer, owner-scoped).",
  tools: (tool) => [
    tool({
      name: CREATE_STRATEGY_TOOL_NAME,
      label: "Create Strategy",
      description:
        "Create a NEW trading strategy. This CREATES it directly (authors Python + a manifest, validates, and persists the strategy + registry pointer immediately, owner-scoped to your workspace) - it does NOT run a backtest, deploy, or touch live money. Provide an intent_brief describing what the strategy should do; other fields are optional hints for the engine.",
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
        return runCreateStrategy(
          params as CreateStrategyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
