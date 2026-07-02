import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_fills.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_LIVE_FILLS_TOOL_NAME = "list_live_fills";

export type ListLiveFillsDeps = {
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

export type ListLiveFillsParams = {
  account_id: string;
  cursor?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_live_fills: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListLiveFills(
  params: ListLiveFillsParams,
  deps: ListLiveFillsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/fills`, {
    query: {
      account_id: params.account_id,
      cursor: params.cursor,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-live-fills",
  name: "VC Trader AI List Live Fills",
  description:
    "Read-only workspace-scoped tool: List the signed-in user's recent live fills via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_FILLS_TOOL_NAME,
      label: "List Live Fills",
      description:
        "List the signed-in user's recent live fills via the live read endpoints. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read fills for.",
          minLength: 1,
        }),
        cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor." })),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum fills to return.", minimum: 1, maximum: 500 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListLiveFills(
          params as ListLiveFillsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
