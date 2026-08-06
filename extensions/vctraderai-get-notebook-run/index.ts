import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_notebook_run (T0-1 notebook reads, 2026-08-05).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope. This is the NOTEBOOK store - without it the
// agent answered "no notebook runs exist" from the backtest store while real
// notebook rows sat unread.

export const GET_NOTEBOOK_RUN_TOOL_NAME = "get_notebook_run";

export type GetNotebookRunDeps = {
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

export type GetNotebookRunParams = {
  run_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_notebook_run: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetNotebookRun(
  params: GetNotebookRunParams,
  deps: GetNotebookRunDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof params.run_id !== "string" || params.run_id.length === 0) {
    throw new Error("vctraderai get_notebook_run: run_id is required");
  }
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/openclaw/research/notebook-runs/${encodeURIComponent(params.run_id)}`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-notebook-run",
  name: "VC Trader AI Get Notebook Run",
  description:
    "Read-only workspace-scoped tool: Read one notebook run in full detail, artifact count included.",
  tools: (tool) => [
    tool({
      name: GET_NOTEBOOK_RUN_TOOL_NAME,
      label: "Get Notebook Run",
      description:
        "Read ONE notebook run in full detail (status, engine, params, error summary, artifact count) from the workspace's notebook store. Required: run_id (from list_notebook_runs). READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        run_id: Type.String({ description: "The notebook run id (UUID)." }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetNotebookRun(
          params as GetNotebookRunParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
