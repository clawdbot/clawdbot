import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_traders.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/traders` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_traders` function.

export const LIST_TRADERS_TOOL_NAME = "list_traders";

export type ListTradersDeps = {
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

export type ListTradersParams = {
  limit?: number;
};

export async function runListTraders(
  params: ListTradersParams,
  deps: ListTradersDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/traders`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-traders",
  name: "VC Trader AI List Traders",
  description: "Read-only catalogue listing of traders.",
  tools: (tool) => [
    tool({
      name: LIST_TRADERS_TOOL_NAME,
      label: "List Traders",
      description:
        "List traders from the propfirm_manager core.traders catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum rows to return (1..1000, default 200).",
            minimum: 1,
            maximum: 1000,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListTraders(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
