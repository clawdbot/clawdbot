import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_open_positions.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_OPEN_POSITIONS_TOOL_NAME = "list_open_positions";

export type ListOpenPositionsDeps = {
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

export type ListOpenPositionsParams = {
  mt5_login?: number;
  live_account_id?: string;
  server?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_open_positions: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListOpenPositions(
  params: ListOpenPositionsParams = {},
  deps: ListOpenPositionsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/live/positions`, {
    query: {
      mt5_login: params.mt5_login !== undefined ? String(params.mt5_login) : undefined,
      live_account_id: params.live_account_id,
      server: params.server,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-open-positions",
  name: "VC Trader AI List Open Positions",
  description:
    "Read-only workspace-scoped tool: List live OPEN positions via the read-only cross-VPC seam.",
  tools: (tool) => [
    tool({
      name: LIST_OPEN_POSITIONS_TOOL_NAME,
      label: "List Open Positions",
      description:
        "List live OPEN positions via the read-only cross-VPC seam. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        mt5_login: Type.Optional(Type.Integer({ description: "Filter by MT5 login." })),
        live_account_id: Type.Optional(Type.String({ description: "Filter by live account id." })),
        server: Type.Optional(Type.String({ description: "Filter by broker server." })),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum rows to return.", minimum: 1, maximum: 1000 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListOpenPositions(
          params as ListOpenPositionsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
