import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_experiment_run.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_EXPERIMENT_RUN_TOOL_NAME = "get_experiment_run";

export type GetExperimentRunDeps = {
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

export type GetExperimentRunParams = {
  run_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_experiment_run: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetExperimentRun(
  params: GetExperimentRunParams,
  deps: GetExperimentRunDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  if (typeof params.run_id !== "string" || params.run_id.length === 0) {
    throw new Error("vctraderai get_experiment_run: run_id is required");
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/research/runs/${params.run_id}`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-experiment-run",
  name: "VC Trader AI Get Experiment Run",
  description: "Read-only workspace-scoped tool: Read one experiment run.",
  tools: (tool) => [
    tool({
      name: GET_EXPERIMENT_RUN_TOOL_NAME,
      label: "Get Experiment Run",
      description:
        "Read one experiment run. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        run_id: Type.String({ description: "Experiment run id.", minLength: 1 }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetExperimentRun(
          params as GetExperimentRunParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
