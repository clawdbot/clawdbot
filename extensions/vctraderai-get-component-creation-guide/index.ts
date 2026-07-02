import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_component_creation_guide.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/component-creation-guide` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.get_component_creation_guide` function.

export const GET_COMPONENT_CREATION_GUIDE_TOOL_NAME = "get_component_creation_guide";

export type GetComponentCreationGuideDeps = {
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

export async function runGetComponentCreationGuide(
  deps: GetComponentCreationGuideDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/component-creation-guide`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-component-creation-guide",
  name: "VC Trader AI Get Component Creation Guide",
  description: "Read-only catalogue component-creation guide envelope.",
  tools: (tool) => [
    tool({
      name: GET_COMPONENT_CREATION_GUIDE_TOOL_NAME,
      label: "Get Component Creation Guide",
      description:
        "Return the propfirm_manager component-creation guide envelope (sections describing how to create strategies, indicators, risk managers, traders). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetComponentCreationGuide({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
