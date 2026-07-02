import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_traders_for_deployment.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_TRADERS_FOR_DEPLOYMENT_TOOL_NAME = "list_traders_for_deployment";

export type ListTradersForDeploymentDeps = {
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

export type ListTradersForDeploymentParams = {};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_traders_for_deployment: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListTradersForDeployment(
  _params: ListTradersForDeploymentParams = {},
  deps: ListTradersForDeploymentDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/deployment/traders`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-traders-for-deployment",
  name: "VC Trader AI List Traders For Deployment",
  description: "Read-only workspace-scoped tool: List traders eligible for deployment.",
  tools: (tool) => [
    tool({
      name: LIST_TRADERS_FOR_DEPLOYMENT_TOOL_NAME,
      label: "List Traders For Deployment",
      description:
        "List traders eligible for deployment. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({}),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListTradersForDeployment(
          params as ListTradersForDeploymentParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
