import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_notebook_artifacts (T0-1 notebook reads, 2026-08-05).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope. This is the NOTEBOOK store - without it the
// agent answered "no notebook runs exist" from the backtest store while real
// notebook rows sat unread.

export const LIST_NOTEBOOK_ARTIFACTS_TOOL_NAME = "list_notebook_artifacts";

export type ListNotebookArtifactsDeps = {
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

export type ListNotebookArtifactsParams = {
  run_id: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_notebook_artifacts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListNotebookArtifacts(
  params: ListNotebookArtifactsParams,
  deps: ListNotebookArtifactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof params.run_id !== "string" || params.run_id.length === 0) {
    throw new Error("vctraderai list_notebook_artifacts: run_id is required");
  }
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/openclaw/research/notebook-runs/${encodeURIComponent(params.run_id)}/artifacts`,
    {
      query: {
        limit: params.limit !== undefined ? String(params.limit) : undefined,
      },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-list-notebook-artifacts",
  name: "VC Trader AI List Notebook Artifacts",
  description:
    "Read-only workspace-scoped tool: List a notebook run's stored outputs, each addressable by artifact id.",
  tools: (tool) => [
    tool({
      name: LIST_NOTEBOOK_ARTIFACTS_TOOL_NAME,
      label: "List Notebook Artifacts",
      description:
        "List a notebook run's STORED OUTPUTS in document order, each addressable by artifact_id with mime_type and size - how a chart or table is DISCOVERED for the chat artifact card. Required: run_id. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        run_id: Type.String({ description: "The notebook run id (UUID)." }),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum artifacts to return.", minimum: 1, maximum: 200 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListNotebookArtifacts(
          params as ListNotebookArtifactsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
