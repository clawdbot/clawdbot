import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_workflow_status.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `/api/v1/openclaw/workflows/${workflow_id}/status` endpoint and returns the
// raw envelope produced by the propfirm_manager
// `engine.agent.tools.workflow_tools.get_workflow_status` function. The BFF
// endpoint will be created in a follow-up V-OC PR; this fork PR is just the
// plugin layer.

export const GET_WORKFLOW_STATUS_TOOL_NAME = "get_workflow_status";

export type GetWorkflowStatusDeps = {
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

export type GetWorkflowStatusParams = {
  workflow_id: string;
};

export async function runGetWorkflowStatus(
  params: GetWorkflowStatusParams,
  deps: GetWorkflowStatusDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/workflows/${encodeURIComponent(params.workflow_id)}/status`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-workflow-status",
  name: "VC Trader AI Get Workflow Status",
  description: "Read-only lookup of an autonomous workflow run status.",
  tools: (tool) => [
    tool({
      name: GET_WORKFLOW_STATUS_TOOL_NAME,
      label: "Get Workflow Status",
      description:
        "Return the status envelope for an autonomous workflow run from the propfirm_manager. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workflow_id: Type.String({
          description: "Workflow run identifier returned by start_autonomous_workflow.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetWorkflowStatus(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
