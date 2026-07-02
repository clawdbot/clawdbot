import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_stop_loss_types.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/stop-loss-types` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_stop_loss_types` function.

export const LIST_STOP_LOSS_TYPES_TOOL_NAME = "list_stop_loss_types";

export type ListStopLossTypesDeps = {
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

export async function runListStopLossTypes(
  deps: ListStopLossTypesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/stop-loss-types`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-stop-loss-types",
  name: "VC Trader AI List Stop Loss Types",
  description: "Read-only catalogue listing of stop-loss types.",
  tools: (tool) => [
    tool({
      name: LIST_STOP_LOSS_TYPES_TOOL_NAME,
      label: "List Stop Loss Types",
      description:
        "List stop-loss types from the propfirm_manager core.stop_loss_types catalogue (stop_loss_type_id, name). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runListStopLossTypes({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
