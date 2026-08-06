import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_notebook_runs (T0-1 notebook reads, 2026-08-05).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope. This is the NOTEBOOK store - without it the
// agent answered "no notebook runs exist" from the backtest store while real
// notebook rows sat unread.

export const LIST_NOTEBOOK_RUNS_TOOL_NAME = "list_notebook_runs";

export type ListNotebookRunsDeps = {
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

export type ListNotebookRunsParams = {
  notebook_id?: string;
  include?: string;
  status?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_notebook_runs: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListNotebookRuns(
  params: ListNotebookRunsParams,
  deps: ListNotebookRunsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/research/notebook-runs`, {
    query: {
      notebook_id: params.notebook_id,
      include: params.include,
      status: params.status,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-notebook-runs",
  name: "VC Trader AI List Notebook Runs",
  description:
    "Read-only workspace-scoped tool: List notebook runs including interactive kernel sessions, newest first.",
  tools: (tool) => [
    tool({
      name: LIST_NOTEBOOK_RUNS_TOOL_NAME,
      label: "List Notebook Runs",
      description:
        "List notebook runs for the workspace, newest first - interactive kernel sessions INCLUDED by default (include=all; pass include=runs for batch only). This is the NOTEBOOK store; for backtest/walkforward experiment runs use list_experiment_runs. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        notebook_id: Type.Optional(Type.String({ description: "Narrow to one notebook (UUID)." })),
        include: Type.Optional(
          Type.String({ description: "all (default, sessions included) or runs (batch only)." }),
        ),
        status: Type.Optional(Type.String({ description: "Filter by run status." })),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum runs to return.", minimum: 1, maximum: 100 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListNotebookRuns(
          params as ListNotebookRunsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
