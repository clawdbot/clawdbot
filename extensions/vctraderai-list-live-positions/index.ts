import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_positions.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_LIVE_POSITIONS_TOOL_NAME = "list_live_positions";

export type ListLivePositionsDeps = {
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

export type ListLivePositionsParams = {
  account_id: string;
  include_closed?: boolean;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_live_positions: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListLivePositions(
  params: ListLivePositionsParams,
  deps: ListLivePositionsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/positions`, {
    query: {
      account_id: params.account_id,
      include_closed:
        params.include_closed !== undefined ? String(params.include_closed) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-live-positions",
  name: "VC Trader AI List Live Positions",
  description:
    "Read-only workspace-scoped tool: List the signed-in user's live OPEN positions via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_POSITIONS_TOOL_NAME,
      label: "List Live Positions",
      description:
        "List the signed-in user's live OPEN positions via the live read endpoints. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read positions for.",
          minLength: 1,
        }),
        include_closed: Type.Optional(
          Type.Boolean({ description: "Include recently closed positions." }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListLivePositions(
          params as ListLivePositionsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
