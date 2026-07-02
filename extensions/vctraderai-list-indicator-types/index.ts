import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_indicator_types.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/indicator-types` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_indicator_types` function.

export const LIST_INDICATOR_TYPES_TOOL_NAME = "list_indicator_types";

export type ListIndicatorTypesDeps = {
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

export async function runListIndicatorTypes(
  deps: ListIndicatorTypesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/indicator-types`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-indicator-types",
  name: "VC Trader AI List Indicator Types",
  description: "Read-only catalogue listing of indicator types.",
  tools: (tool) => [
    tool({
      name: LIST_INDICATOR_TYPES_TOOL_NAME,
      label: "List Indicator Types",
      description:
        "List indicator types from the propfirm_manager core.indicator_types catalogue (indicator_type_id, name). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runListIndicatorTypes({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
