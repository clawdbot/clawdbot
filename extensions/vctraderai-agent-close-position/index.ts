import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_close_position (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response. The BFF gates the
// close against the owner's autonomous-unlock window SERVER-SIDE: if the window
// is open it accepts/executes the close; otherwise it downgrades the request to
// a staged card the owner approves. The response carries accepted_queued /
// executed / downgraded_to_staged / lock_reason.

export const AGENT_CLOSE_POSITION_TOOL_NAME = "agent_close_position";

export type AgentClosePositionDeps = {
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

export type AgentClosePositionParams = {
  account_id: string;
  position_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_close_position: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runAgentClosePosition(
  params: AgentClosePositionParams,
  deps: AgentClosePositionDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/live/positions/${params.position_id}/agent-close`,
    {
      method: "POST",
      body: { account_id: params.account_id },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-agent-close-position",
  name: "VC Trader AI Agent Close Position",
  description:
    "Autonomously close a live OPEN position while the owner's autonomous-unlock window is open; otherwise downgrade to a staged card.",
  tools: (tool) => [
    tool({
      name: AGENT_CLOSE_POSITION_TOOL_NAME,
      label: "Agent Close Position",
      description:
        "Autonomously close a live OPEN position while the owner's autonomous-unlock window is open; otherwise downgrade to a staged card.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the position.",
          minLength: 1,
        }),
        position_id: Type.String({
          description: "Live OPEN position id to close.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentClosePosition(
          params as AgentClosePositionParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
