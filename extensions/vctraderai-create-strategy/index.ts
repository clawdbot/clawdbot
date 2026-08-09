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
  intent_brief?: string;
  /** Complete agent-authored Python; the BFF assigns source provenance. */
  source_text: string;
  entry_function?: string;
  runtime_tag?: "vbt" | "nautilus";
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
    "Creates a directly authored Python strategy, validated and persisted owner-scoped; no second authoring model.",
  tools: (tool) => [
    tool({
      name: CREATE_STRATEGY_TOOL_NAME,
      label: "Create Strategy",
      description:
        "Create a NEW trading strategy directly. Always provide complete native-Python source_text, then lint before create. runtime_tag=vbt with run(...) is a research signal artifact. runtime_tag=nautilus requires a named nautilus_trader Strategy class in entry_function; only a pinned validated Nautilus class can deploy. This does not backtest, deploy, or touch live money.",
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
          intent_brief: Type.Optional(
            Type.String({ description: "Optional concise intent metadata for the strategy." }),
          ),
          source_text: Type.String({
            description:
              "Required complete native-Python source. Use run(...) for vbt research, or a named nautilus_trader Strategy class for runtime_tag=nautilus.",
            minLength: 1,
          }),
          entry_function: Type.Optional(
            Type.String({
              description:
                "run for vbt research; the exact Strategy class name for a native Nautilus artifact.",
            }),
          ),
          runtime_tag: Type.Optional(
            Type.String({
              enum: ["vbt", "nautilus"],
              description: "vbt is research; nautilus selects the class-native, deployable lane.",
            }),
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
