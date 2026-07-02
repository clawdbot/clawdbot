import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_risk_managers.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/risk-managers` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_risk_managers` function.

export const LIST_RISK_MANAGERS_TOOL_NAME = "list_risk_managers";

export type ListRiskManagersDeps = {
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

export type ListRiskManagersParams = {
  limit?: number;
};

export async function runListRiskManagers(
  params: ListRiskManagersParams,
  deps: ListRiskManagersDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/risk-managers`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-risk-managers",
  name: "VC Trader AI List Risk Managers",
  description: "Read-only catalogue listing of risk managers.",
  tools: (tool) => [
    tool({
      name: LIST_RISK_MANAGERS_TOOL_NAME,
      label: "List Risk Managers",
      description:
        "List risk managers from the propfirm_manager core.risk_managers catalogue. READ_ONLY per ADR 0078 - no mutation.",
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
        return runListRiskManagers(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
