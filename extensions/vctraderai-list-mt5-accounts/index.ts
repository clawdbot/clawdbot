import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_mt5_accounts.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read GET /api/v1/workspaces/{ws}/openclaw/live/accounts
// as the workspace owner (PFM_AGENT_TOKEN) and returns the verbatim envelope.

export const LIST_MT5_ACCOUNTS_TOOL_NAME = "list_mt5_accounts";

export type ListMt5AccountsDeps = {
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

export type ListMt5AccountsParams = {
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_mt5_accounts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListMt5Accounts(
  params: ListMt5AccountsParams = {},
  deps: ListMt5AccountsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/live/accounts`, {
    query: { limit: params.limit !== undefined ? String(params.limit) : undefined },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-mt5-accounts",
  name: "VC Trader AI List MT5 Accounts",
  description: "Read-only workspace-scoped list of the workspace's MT5 accounts.",
  tools: (tool) => [
    tool({
      name: LIST_MT5_ACCOUNTS_TOOL_NAME,
      label: "List MT5 Accounts",
      description:
        "List the MT5 accounts in this workspace. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum accounts to return (bounded server-side).",
            minimum: 1,
            maximum: 500,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListMt5Accounts(
          params as ListMt5AccountsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
