import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: start_autonomous_workflow.
//
// Classified read-only-ish in V-OC tool_mapping cluster D. Calls the BFF
// `POST /api/v1/openclaw/workflows/start` endpoint with the workflow kind +
// params body, and returns the envelope produced by the propfirm_manager
// `engine.agent.tools.workflow_tools.start_autonomous_workflow` function:
// `{ workflow_id, initial_status, ... }`. The BFF endpoint will be created in
// a follow-up V-OC PR; this fork PR is just the plugin layer.

export const START_AUTONOMOUS_WORKFLOW_TOOL_NAME = "start_autonomous_workflow";

export type StartAutonomousWorkflowDeps = {
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

export type StartAutonomousWorkflowParams = {
  workflow_kind: string;
  params: Record<string, unknown>;
};

export async function runStartAutonomousWorkflow(
  params: StartAutonomousWorkflowParams,
  deps: StartAutonomousWorkflowDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/workflows/start", {
    method: "POST",
    body: {
      workflow_kind: params.workflow_kind,
      params: params.params,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-start-autonomous-workflow",
  name: "VC Trader AI Start Autonomous Workflow",
  description:
    "Starts an autonomous workflow run on the propfirm_manager and returns the workflow id and initial status.",
  tools: (tool) => [
    tool({
      name: START_AUTONOMOUS_WORKFLOW_TOOL_NAME,
      label: "Start Autonomous Workflow",
      description:
        "Start an autonomous workflow run by kind with the provided params. Returns the workflow id and initial status from the propfirm_manager. Classified read-only-ish per V-OC tool_mapping cluster D - does not mutate live trading state.",
      parameters: Type.Object({
        workflow_kind: Type.String({
          description: "Workflow kind identifier (e.g. 'symbol_discovery', 'parameter_sweep').",
          minLength: 1,
        }),
        params: Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow-kind specific params payload.",
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runStartAutonomousWorkflow(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
