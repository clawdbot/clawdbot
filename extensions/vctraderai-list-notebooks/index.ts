import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_notebooks (T0-1 notebook reads, 2026-08-05).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope. This is the NOTEBOOK store - without it the
// agent answered "no notebook runs exist" from the backtest store while real
// notebook rows sat unread.

export const LIST_NOTEBOOKS_TOOL_NAME = "list_notebooks";

export type ListNotebooksDeps = {
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

export type ListNotebooksParams = {
  project_id?: string;
  include_archived?: boolean;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_notebooks: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListNotebooks(
  params: ListNotebooksParams,
  deps: ListNotebooksDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/research/notebooks`, {
    query: {
      project_id: params.project_id,
      include_archived:
        params.include_archived !== undefined ? String(params.include_archived) : undefined,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-notebooks",
  name: "VC Trader AI List Notebooks",
  description:
    "Read-only workspace-scoped tool: List the workspace's notebooks (title, purpose, author, archived state).",
  tools: (tool) => [
    tool({
      name: LIST_NOTEBOOKS_TOOL_NAME,
      label: "List Notebooks",
      description:
        "List the workspace's notebooks (title, purpose, template kind, author, archived state), newest first. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Narrow to one project (UUID)." })),
        include_archived: Type.Optional(
          Type.Boolean({ description: "Include archived notebooks (default false)." }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum notebooks to return.", minimum: 1, maximum: 100 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListNotebooks(
          params as ListNotebooksParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
