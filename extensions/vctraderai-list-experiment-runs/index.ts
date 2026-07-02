import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_experiment_runs.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_EXPERIMENT_RUNS_TOOL_NAME = "list_experiment_runs";

export type ListExperimentRunsDeps = {
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

export type ListExperimentRunsParams = {
  schema?: string;
  limit?: number;
  status?: string;
  strategy_id?: string;
  trader_def_id?: string;
  order_by?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_experiment_runs: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListExperimentRuns(
  params: ListExperimentRunsParams = {},
  deps: ListExperimentRunsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/research/runs`, {
    query: {
      schema: params.schema,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      status: params.status,
      strategy_id: params.strategy_id,
      trader_def_id: params.trader_def_id,
      order_by: params.order_by,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-experiment-runs",
  name: "VC Trader AI List Experiment Runs",
  description: "Read-only workspace-scoped tool: List experiment runs for the workspace.",
  tools: (tool) => [
    tool({
      name: LIST_EXPERIMENT_RUNS_TOOL_NAME,
      label: "List Experiment Runs",
      description:
        "List experiment runs for the workspace. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        schema: Type.Optional(
          Type.String({ description: "Result schema (e.g. backtest, walkforward)." }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum runs to return.", minimum: 1, maximum: 200 }),
        ),
        status: Type.Optional(Type.String({ description: "Filter by run status." })),
        strategy_id: Type.Optional(Type.String({ description: "Filter by strategy id." })),
        trader_def_id: Type.Optional(
          Type.String({ description: "Filter by trader definition id." }),
        ),
        order_by: Type.Optional(Type.String({ description: "Ordering (e.g. recent)." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListExperimentRuns(
          params as ListExperimentRunsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
