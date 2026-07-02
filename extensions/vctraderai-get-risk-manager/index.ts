import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_risk_manager.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/risk-managers/${risk_manager_id}` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_risk_manager` function.

export const GET_RISK_MANAGER_TOOL_NAME = "get_risk_manager";

export type GetRiskManagerDeps = {
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

export type GetRiskManagerParams = {
  risk_manager_id: string;
};

export async function runGetRiskManager(
  params: GetRiskManagerParams,
  deps: GetRiskManagerDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/risk-managers/${encodeURIComponent(params.risk_manager_id)}`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-risk-manager",
  name: "VC Trader AI Get Risk Manager",
  description: "Read-only catalogue lookup of a single risk manager.",
  tools: (tool) => [
    tool({
      name: GET_RISK_MANAGER_TOOL_NAME,
      label: "Get Risk Manager",
      description:
        "Return a single risk manager row from the propfirm_manager core.risk_managers catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        risk_manager_id: Type.String({
          description: "Risk manager identifier (UUID or short slug).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetRiskManager(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
