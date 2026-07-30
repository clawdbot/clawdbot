import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: dispatch_strategy_experiment (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a strategy-first experiment-launch proposal; it NEVER dispatches
// directly. It POSTs to the BFF staged-action chokepoint
// `POST /api/v1/openclaw/stage` with `{ tool_name, workspace_id, params,
// summary }`. On Apply, the BFF reuses the v3 dispatch_experiment service in
// process (which emits the experiment_dispatched COMMIT). The optional
// `origin_signal_id` links the run's realized outcome back to the agent signal
// that motivated it (the learning loop).

export const DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME = "dispatch_strategy_experiment";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type DispatchStrategyExperimentDeps = {
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

export type DispatchStrategyExperimentParams = {
  strategy_id?: string;
  strategy_version_id?: string;
  experiment_kind?: string;
  config?: Record<string, unknown>;
  /** Project id OR name; the BFF resolves either. Omitted = the workspace primary. */
  project_id?: string;
  bundle_id?: string;
  idempotency_key?: string;
  origin_signal_id?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai dispatch_strategy_experiment: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: DispatchStrategyExperimentParams): string {
  const kind = params.experiment_kind ?? "experiment";
  const target = params.strategy_version_id ?? params.strategy_id ?? "";
  return `Dispatch ${kind} for strategy ${target}`.trim();
}

export async function runDispatchStrategyExperiment(
  params: DispatchStrategyExperimentParams,
  deps: DispatchStrategyExperimentDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a strategy-experiment dispatch proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-dispatch-strategy-experiment",
  name: "VC Trader AI Dispatch Strategy Experiment (Propose)",
  description:
    "Stages a strategy-first experiment (backtest / prop-sim / walkforward) dispatch proposal for human review; never dispatches directly.",
  tools: (tool) => [
    tool({
      name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      label: "Dispatch Strategy Experiment",
      description:
        'Propose a strategy-first experiment (backtest / prop-sim / walkforward) launch against a registered strategy version. This STAGES a proposal for the human to review + Apply in the chat - it does NOT dispatch directly. PROPOSE_ONLY per ADR 0078. Provide strategy_id (or strategy_version_id) and experiment_kind. experiment_kind MUST be one of these six DISPATCHABLE catalogue values: vbt_backtest, vbt_walkforward, nautilus_backtest, nautilus_walkforward, nautilus_prop_sim, nautilus_prop_walkforward - a bare "backtest" or "walkforward" is NOT a kind. The 8-kind catalogue also lists TWO kinds that are NON-DISPATCHABLE in V2 and are rejected with a 422 before anything is staged, so never propose them: stage_b_bundle_run (DEFERRED TO V3) and vbt_prop_sim (BFF-stubbed at v1.0, engine ships at v1.1 - use nautilus_prop_sim instead). Of the six, only vbt_backtest, vbt_walkforward, nautilus_backtest and nautilus_walkforward reach the real engine; nautilus_prop_sim and nautilus_prop_walkforward are accepted but PARK at state "deferred_pending" with an empty result envelope, so never promise the user metrics from those two. config MUST carry the run window using exactly the keys instrument, from_ts and to_ts (the catalogue declares a date such as 2026-02-01; a full ISO-8601 timestamp also works). The two dispatchable prop kinds (nautilus_prop_sim, nautilus_prop_walkforward) additionally require config.rule_overlay, one of "prop_firm" or "standard". When the launch stems from a view you emitted with emit_specialist_signal, ALSO pass origin_signal_id set to that signal\'s id so the learning loop can bind the run\'s outcome to your proposal.',
      parameters: Type.Object(
        {
          strategy_id: Type.Optional(
            Type.String({ description: "Registered strategy id to run." }),
          ),
          strategy_version_id: Type.Optional(
            Type.String({ description: "Specific strategy version id to run." }),
          ),
          experiment_kind: Type.Optional(
            Type.String({
              description:
                'One of the six dispatchable catalogue kinds: vbt_backtest, vbt_walkforward, nautilus_backtest, nautilus_walkforward, nautilus_prop_sim, nautilus_prop_walkforward. Two further catalogue kinds are non-dispatchable in V2 and ALWAYS 422: stage_b_bundle_run (DEFERRED TO V3) and vbt_prop_sim (BFF-stubbed at v1.0). Bare "backtest" / "walkforward" are legacy aliases and may be rejected.',
              examples: ["vbt_backtest", "nautilus_walkforward"],
            }),
          ),
          config: Type.Optional(
            Type.Object(
              {},
              {
                additionalProperties: true,
                description:
                  'Run config. REQUIRED keys: instrument (e.g. EUR_USD), from_ts and to_ts (window bounds; the catalogue declares a date such as 2026-02-01, and a full ISO-8601 timestamp also works). Use exactly those canonical key names. The dispatchable prop kinds (nautilus_prop_sim, nautilus_prop_walkforward) ALSO require rule_overlay, one of "prop_firm" or "standard". Optional: timeframe.',
                examples: [
                  {
                    instrument: "EUR_USD",
                    timeframe: "1h",
                    from_ts: "2026-02-01T00:00:00Z",
                    to_ts: "2026-07-29T00:00:00Z",
                  },
                ],
              },
            ),
          ),
          project_id: Type.Optional(
            Type.String({
              description:
                "The project this experiment belongs to. Accepts either the project id or its NAME (the BFF resolves both). Optional — omitted means the workspace's primary project — but PREFER naming one: an experiment's only list surface in the product is its project, so this decides where the human can find the run afterwards. An experiment with no project executes and succeeds but is invisible in Projects and Experiments.",
              examples: ["Alpha Research"],
            }),
          ),
          bundle_id: Type.Optional(Type.String({ description: "Optional bundle id." })),
          idempotency_key: Type.Optional(
            Type.String({ description: "Optional idempotency key (auto-derived if omitted)." }),
          ),
          origin_signal_id: Type.Optional(
            Type.String({
              description:
                "Optional: the emit_specialist_signal signal_id that motivated this launch (learning-loop link).",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDispatchStrategyExperiment(
          params as DispatchStrategyExperimentParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
