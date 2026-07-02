import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: account_state.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// two workspace-scoped BFF reads and returns their composed payload. The
// helper guards path egress; the docker sandbox guards network egress.

export const ACCOUNT_STATE_TOOL_NAME = "account_state";

export type AccountStateResult = {
  stats: unknown;
  accounts: unknown;
};

export type AccountStateDeps = {
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

export async function runAccountState(
  workspaceId: string,
  deps: AccountStateDeps = {},
  signal?: AbortSignal,
): Promise<AccountStateResult> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const [stats, accounts] = await Promise.all([
    bffFetch(`/api/v1/workspaces/${workspaceId}/dashboard/home`, { signal }),
    bffFetch(`/api/v1/workspaces/${workspaceId}/accounts`, {
      signal,
      query: { state: "active" },
    }),
  ]);
  return { stats, accounts };
}

export default defineToolPlugin({
  id: "vctraderai-account-state",
  name: "VC Trader AI Account State",
  description:
    "Read-only inspector for workspace account state (dashboard 5-stat block + accounts list).",
  tools: (tool) => [
    tool({
      name: ACCOUNT_STATE_TOOL_NAME,
      label: "Account State",
      description:
        "Returns the workspace 5-stat dashboard block plus the active accounts list. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAccountState(params.workspace_id, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
