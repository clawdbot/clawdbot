import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_tree.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/tree`
// endpoint and returns the raw envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.list_tree` function (base, items, sources,
// filters). The BFF clamps `root` to the sandbox-allowed data root - any
// out-of-sandbox path is rejected server-side.

export const LIST_TREE_TOOL_NAME = "list_tree";

export type ListTreeDeps = {
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

export type ListTreeParams = {
  root?: string;
};

export async function runListTree(
  params: ListTreeParams,
  deps: ListTreeDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/tree`, {
    query: {
      root: params.root,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-tree",
  name: "VC Trader AI List Tree",
  description: "Read-only sandbox-scoped filesystem listing under the configured data root.",
  tools: (tool) => [
    tool({
      name: LIST_TREE_TOOL_NAME,
      label: "List Tree",
      description:
        "List files + directories under the configured data root (or `root` subpath). The BFF clamps `root` to the sandbox-allowed agentDir and rejects out-of-sandbox paths. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        root: Type.Optional(
          Type.String({
            description:
              "Subpath relative to the configured data root (optional; defaults to the sandbox-allowed root).",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListTree(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
