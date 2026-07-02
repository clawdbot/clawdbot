import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_live_account_state.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_LIVE_ACCOUNT_STATE_TOOL_NAME = "get_live_account_state";

export type GetLiveAccountStateDeps = {
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

export type GetLiveAccountStateParams = {
  account_id?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_live_account_state: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetLiveAccountState(
  params: GetLiveAccountStateParams = {},
  deps: GetLiveAccountStateDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/account-state`, {
    query: {
      account_id: params.account_id,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-live-account-state",
  name: "VC Trader AI Get Live Account State",
  description:
    "Read-only workspace-scoped tool: Read the signed-in user's live account-state (balance/equity/open PnL).",
  tools: (tool) => [
    tool({
      name: GET_LIVE_ACCOUNT_STATE_TOOL_NAME,
      label: "Get Live Account State",
      description:
        "Read the signed-in user's live account-state (balance/equity/open PnL). READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.Optional(
          Type.String({
            description: "Optional account id; defaults to the primary live account.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetLiveAccountState(
          params as GetLiveAccountStateParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
