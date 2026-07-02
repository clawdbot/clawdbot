import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_trade_annotations.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_TRADE_ANNOTATIONS_TOOL_NAME = "list_trade_annotations";

export type ListTradeAnnotationsDeps = {
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

export type ListTradeAnnotationsParams = {
  trade_source?: string;
  source_run_id?: string;
  trade_key?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_trade_annotations: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListTradeAnnotations(
  params: ListTradeAnnotationsParams = {},
  deps: ListTradeAnnotationsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/journal`, {
    query: {
      trade_source: params.trade_source,
      source_run_id: params.source_run_id,
      trade_key: params.trade_key,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-trade-annotations",
  name: "VC Trader AI List Trade Annotations",
  description:
    "Read-only workspace-scoped tool: List trade journal annotations for the workspace, optionally filtered by trade binding.",
  tools: (tool) => [
    tool({
      name: LIST_TRADE_ANNOTATIONS_TOOL_NAME,
      label: "List Trade Annotations",
      description:
        "List trade journal annotations for the workspace, optionally filtered by trade binding. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        trade_source: Type.Optional(
          Type.String({ description: "Filter by the trade source the note hangs off." }),
        ),
        source_run_id: Type.Optional(Type.String({ description: "Filter by source run id." })),
        trade_key: Type.Optional(Type.String({ description: "Filter by trade key." })),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum annotations to return.", minimum: 1, maximum: 200 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListTradeAnnotations(
          params as ListTradeAnnotationsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
