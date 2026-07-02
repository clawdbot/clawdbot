import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: audit.
//
// READ_ONLY per ADR 0078. Calls the BFF `agentThreadAudit` operation
// (agent_alpha.openapi.yaml) and returns the raw ThreadAuditEnvelope. We
// return the envelope unchanged so the model gets the full timeline shape.

export const AUDIT_TOOL_NAME = "audit";

export type AuditDeps = {
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

export async function runAudit(
  workspaceId: string,
  threadId: string,
  deps: AuditDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${workspaceId}/agent/threads/${threadId}/audit`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-audit",
  name: "VC Trader AI Audit",
  description: "Read-only inspector for an agent thread's audit timeline.",
  tools: (tool) => [
    tool({
      name: AUDIT_TOOL_NAME,
      label: "Audit",
      description:
        "Fetch the audit timeline for an agent thread and return the ThreadAuditEnvelope unchanged. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        thread_id: Type.String({
          description: "Agent thread UUID.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAudit(
          params.workspace_id,
          params.thread_id,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
