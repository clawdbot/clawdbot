import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_risk_manager_source.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/risk-managers/${risk_manager_id}/source` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_risk_manager_source` function.

export const GET_RISK_MANAGER_SOURCE_TOOL_NAME = "get_risk_manager_source";

export type GetRiskManagerSourceDeps = {
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

export type GetRiskManagerSourceParams = {
  risk_manager_id: string;
};

export async function runGetRiskManagerSource(
  params: GetRiskManagerSourceParams,
  deps: GetRiskManagerSourceDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/risk-managers/${encodeURIComponent(params.risk_manager_id)}/source`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-risk-manager-source",
  name: "VC Trader AI Get Risk Manager Source",
  description: "Read-only catalogue source for a risk manager.",
  tools: (tool) => [
    tool({
      name: GET_RISK_MANAGER_SOURCE_TOOL_NAME,
      label: "Get Risk Manager Source",
      description:
        "Return the source artefact for a single risk manager from the propfirm_manager catalogue. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        risk_manager_id: Type.String({
          description: "Risk manager identifier (UUID or short slug).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetRiskManagerSource(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
