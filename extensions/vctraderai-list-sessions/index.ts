import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_sessions.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/sessions` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_sessions` function.

export const LIST_SESSIONS_TOOL_NAME = "list_sessions";

export type ListSessionsDeps = {
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

export async function runListSessions(
  deps: ListSessionsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/sessions`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-sessions",
  name: "VC Trader AI List Sessions",
  description: "Read-only catalogue listing of trading sessions.",
  tools: (tool) => [
    tool({
      name: LIST_SESSIONS_TOOL_NAME,
      label: "List Sessions",
      description:
        "List trading sessions from the propfirm_manager core.sessions catalogue (session_id, code, start_time_utc, end_time_utc). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runListSessions({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
