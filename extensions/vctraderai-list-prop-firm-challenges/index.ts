import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_prop_firm_challenges.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/prop-firm-challenges` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_prop_firm_challenges` function.

export const LIST_PROP_FIRM_CHALLENGES_TOOL_NAME = "list_prop_firm_challenges";

export type ListPropFirmChallengesDeps = {
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

export type ListPropFirmChallengesParams = {
  limit?: number;
};

export async function runListPropFirmChallenges(
  params: ListPropFirmChallengesParams,
  deps: ListPropFirmChallengesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/prop-firm-challenges`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-prop-firm-challenges",
  name: "VC Trader AI List Prop-Firm Challenges",
  description: "Read-only catalogue listing of prop-firm challenges.",
  tools: (tool) => [
    tool({
      name: LIST_PROP_FIRM_CHALLENGES_TOOL_NAME,
      label: "List Prop-Firm Challenges",
      description:
        "List prop-firm challenge templates from the propfirm_manager catalogue. READ_ONLY per ADR 0078 - no mutation.",
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
        return runListPropFirmChallenges(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
