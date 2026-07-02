import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_correlation_matrix.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_CORRELATION_MATRIX_TOOL_NAME = "get_correlation_matrix";

export type GetCorrelationMatrixDeps = {
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

export type GetCorrelationMatrixParams = {
  method?: string;
  min_overlap?: number;
  window_days?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_correlation_matrix: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetCorrelationMatrix(
  params: GetCorrelationMatrixParams = {},
  deps: GetCorrelationMatrixDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/analytics/correlation-matrix`, {
    query: {
      method: params.method,
      min_overlap: params.min_overlap !== undefined ? String(params.min_overlap) : undefined,
      window_days: params.window_days !== undefined ? String(params.window_days) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-correlation-matrix",
  name: "VC Trader AI Get Correlation Matrix",
  description:
    "Read-only workspace-scoped tool: Read the workspace portfolio correlation matrix across accounts' daily net-PnL streams.",
  tools: (tool) => [
    tool({
      name: GET_CORRELATION_MATRIX_TOOL_NAME,
      label: "Get Correlation Matrix",
      description:
        "Read the workspace portfolio correlation matrix across accounts' daily net-PnL streams. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        method: Type.Optional(
          Type.String({ description: "Correlation method (e.g. pearson, spearman)." }),
        ),
        min_overlap: Type.Optional(
          Type.Integer({
            description: "Minimum overlapping observations.",
            minimum: 2,
            maximum: 500,
          }),
        ),
        window_days: Type.Optional(
          Type.Integer({ description: "Lookback window in days.", minimum: 1, maximum: 1825 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetCorrelationMatrix(
          params as GetCorrelationMatrixParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
