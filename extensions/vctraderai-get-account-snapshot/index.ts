import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_account_snapshot.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_ACCOUNT_SNAPSHOT_TOOL_NAME = "get_account_snapshot";

export type GetAccountSnapshotDeps = {
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

export type GetAccountSnapshotParams = {
  mt5_account_id: string;
  history_limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_account_snapshot: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetAccountSnapshot(
  params: GetAccountSnapshotParams,
  deps: GetAccountSnapshotDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  if (typeof params.mt5_account_id !== "string" || params.mt5_account_id.length === 0) {
    throw new Error("vctraderai get_account_snapshot: mt5_account_id is required");
  }
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/openclaw/live/accounts/${params.mt5_account_id}/snapshot`,
    {
      query: {
        history_limit:
          params.history_limit !== undefined ? String(params.history_limit) : undefined,
      },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-account-snapshot",
  name: "VC Trader AI Get Account Snapshot",
  description:
    "Read-only workspace-scoped tool: Read one owned account plus its latest synced snapshot.",
  tools: (tool) => [
    tool({
      name: GET_ACCOUNT_SNAPSHOT_TOOL_NAME,
      label: "Get Account Snapshot",
      description:
        "Read one owned account plus its latest synced snapshot. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        mt5_account_id: Type.String({ description: "MT5 account id to snapshot.", minLength: 1 }),
        history_limit: Type.Optional(
          Type.Integer({
            description: "Snapshot history rows to include.",
            minimum: 1,
            maximum: 500,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetAccountSnapshot(
          params as GetAccountSnapshotParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
