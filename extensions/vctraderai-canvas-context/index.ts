import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: canvas_context.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const CANVAS_CONTEXT_TOOL_NAME = "canvas_context";

export type CanvasContextDeps = {
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

export type CanvasContextParams = {
  account_id: string;
  symbol: string;
  timeframe: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai canvas_context: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runCanvasContext(
  params: CanvasContextParams,
  deps: CanvasContextDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/cockpit/canvas`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframe: params.timeframe,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-canvas-context",
  name: "VC Trader AI Canvas Context",
  description:
    "Read-only workspace-scoped tool: Read the durable cockpit canvas document (chart drawings as data) for one chart.",
  tools: (tool) => [
    tool({
      name: CANVAS_CONTEXT_TOOL_NAME,
      label: "Canvas Context",
      description:
        "Read the durable cockpit canvas document (chart drawings as data) for one chart. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.String({ description: "Account id for the chart.", minLength: 1 }),
        symbol: Type.String({ description: "Instrument symbol (e.g. EUR_USD).", minLength: 1 }),
        timeframe: Type.String({ description: "Timeframe code (e.g. H1).", minLength: 1 }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCanvasContext(
          params as CanvasContextParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
