import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_playbook_history.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `GET /api/v1/openclaw/playbooks/history?workspace_id=<uuid>&limit=<int>`
// endpoint and returns the envelope of recently generated playbooks for the
// workspace. No mutation - read-only history view.

export const GET_PLAYBOOK_HISTORY_TOOL_NAME = "get_playbook_history";

export type GetPlaybookHistoryDeps = {
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

export type GetPlaybookHistoryParams = {
  workspace_id: string;
  limit?: number;
};

export async function runGetPlaybookHistory(
  params: GetPlaybookHistoryParams,
  deps: GetPlaybookHistoryDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const query: Record<string, string | undefined> = {
    workspace_id: params.workspace_id,
  };
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    query.limit = String(params.limit);
  }
  return bffFetch("/api/v1/openclaw/playbooks/history", {
    method: "GET",
    query,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-playbook-history",
  name: "VC Trader AI Get Playbook History",
  description: "Read-only lookup of recent playbooks for a workspace.",
  tools: (tool) => [
    tool({
      name: GET_PLAYBOOK_HISTORY_TOOL_NAME,
      label: "Get Playbook History",
      description:
        "Return recent playbook envelopes for a workspace. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        limit: Type.Optional(
          Type.Integer({
            description:
              "Optional maximum number of playbooks to return. Defaults to BFF-side default (typically 20).",
            minimum: 1,
            maximum: 500,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetPlaybookHistory(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
