import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_data_root.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/root` endpoint
// and returns the raw DataRootEnvelope shape produced by the propfirm_manager
// `engine.tools.market_data_tools.get_data_root` function (root path, exists
// flag, providers list, key_subfolders list, sources list).

export const GET_DATA_ROOT_TOOL_NAME = "get_data_root";

export type GetDataRootDeps = {
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

export async function runGetDataRoot(
  deps: GetDataRootDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/root`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-data-root",
  name: "VC Trader AI Get Data Root",
  description: "Read-only resolver for the propfirm_manager data root.",
  tools: (tool) => [
    tool({
      name: GET_DATA_ROOT_TOOL_NAME,
      label: "Get Data Root",
      description:
        "Resolve the configured data root (local filesystem path or s3:// URI) and return the providers + key_subfolders that exist beneath it. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetDataRoot({ threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
