import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: recall_decisions (agent decision-ledger read-back).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped decision-recall read as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim envelope. The agent uses this to
// review its OWN recent decisions (most-recent first) before deciding again,
// with optional filters by kind / instrument / limit.

export const RECALL_DECISIONS_TOOL_NAME = "recall_decisions";

export type RecallDecisionsDeps = {
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

export type RecallDecisionsParams = {
  kind?: string;
  instrument?: string;
  limit?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai recall_decisions: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runRecallDecisions(
  params: RecallDecisionsParams,
  deps: RecallDecisionsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  // All filters are optional; the BFF clamps `limit` to [1, 50]. Pass the raw
  // strings straight through as query params (buildQueryString drops empties).
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/decision-recall`, {
    query: {
      kind: nonEmpty(params.kind),
      instrument: nonEmpty(params.instrument),
      limit: nonEmpty(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-recall-decisions",
  name: "VC Trader AI Recall Decisions",
  description:
    "Read-only workspace-scoped tool: recall the agent's OWN recent decision-ledger entries from the live read endpoints via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). READ_ONLY per ADR 0078.",
  tools: (tool) => [
    tool({
      name: RECALL_DECISIONS_TOOL_NAME,
      label: "Recall Decisions",
      description:
        "Recall your OWN recent decision-ledger entries for this workspace (most-recent first). Optional filters: kind (the decision kind), instrument (e.g. EUR_USD), limit (1-50, default 20). Read-only; owner-scoped to your workspace. Returns a list of prior decisions (kind, ts, actor, payload) so you can review your history before deciding again.",
      parameters: Type.Object({
        kind: Type.Optional(
          Type.String({
            description: "Optional filter: the decision kind to recall.",
          }),
        ),
        instrument: Type.Optional(
          Type.String({
            description: "Optional filter: the instrument (e.g. EUR_USD).",
          }),
        ),
        limit: Type.Optional(
          Type.String({
            description: "Optional: how many entries to return (1-50, default 20).",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRecallDecisions(
          params as RecallDecisionsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
