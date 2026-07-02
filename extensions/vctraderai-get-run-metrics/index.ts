import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_run_metrics.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_RUN_METRICS_TOOL_NAME = "get_run_metrics";

export type GetRunMetricsDeps = {
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

export type GetRunMetricsParams = {
  run_id: string;
  schema?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_run_metrics: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetRunMetrics(
  params: GetRunMetricsParams,
  deps: GetRunMetricsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  if (typeof params.run_id !== "string" || params.run_id.length === 0) {
    throw new Error("vctraderai get_run_metrics: run_id is required");
  }
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/openclaw/research/runs/${params.run_id}/metrics`,
    {
      query: {
        schema: params.schema,
        limit: params.limit !== undefined ? String(params.limit) : undefined,
      },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-run-metrics",
  name: "VC Trader AI Get Run Metrics",
  description: "Read-only workspace-scoped tool: Read the metrics for one experiment run.",
  tools: (tool) => [
    tool({
      name: GET_RUN_METRICS_TOOL_NAME,
      label: "Get Run Metrics",
      description:
        "Read the metrics for one experiment run. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        run_id: Type.String({ description: "Experiment run id.", minLength: 1 }),
        schema: Type.Optional(
          Type.String({ description: "Result schema (e.g. backtest, walkforward)." }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum metric rows.", minimum: 1, maximum: 1000 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetRunMetrics(
          params as GetRunMetricsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
