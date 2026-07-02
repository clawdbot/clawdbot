import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_current_deployments.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_CURRENT_DEPLOYMENTS_TOOL_NAME = "list_current_deployments";

export type ListCurrentDeploymentsDeps = {
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

export type ListCurrentDeploymentsParams = {};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_current_deployments: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListCurrentDeployments(
  _params: ListCurrentDeploymentsParams = {},
  deps: ListCurrentDeploymentsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/deployment/current`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-current-deployments",
  name: "VC Trader AI List Current Deployments",
  description: "Read-only workspace-scoped tool: List current deployments.",
  tools: (tool) => [
    tool({
      name: LIST_CURRENT_DEPLOYMENTS_TOOL_NAME,
      label: "List Current Deployments",
      description:
        "List current deployments. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({}),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListCurrentDeployments(
          params as ListCurrentDeploymentsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
