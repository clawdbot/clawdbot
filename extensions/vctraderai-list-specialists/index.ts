import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_specialists.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it. The route derives the workspace from the
// trusted container env and takes NO body or query — this plugin sends neither.

export const LIST_SPECIALISTS_TOOL_NAME = "list_specialists";

export type ListSpecialistsDeps = {
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

export type ListSpecialistsParams = Record<string, unknown>;

export async function runListSpecialists(
  _params: ListSpecialistsParams,
  deps: ListSpecialistsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/specialists", {
    method: "GET",
    headers: { "X-OpenClaw-Tool": LIST_SPECIALISTS_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-specialists",
  name: "VC Trader AI List Specialists",
  description:
    "List the workspace's registered Agent Alpha specialists through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: LIST_SPECIALISTS_TOOL_NAME,
      label: "List Specialists",
      description:
        "List the workspace's registered Agent Alpha specialists through the guarded internal BFF route.",
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListSpecialists(
          params as ListSpecialistsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
