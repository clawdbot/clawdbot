import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_instruments.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/instruments` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_instruments` function.

export const LIST_INSTRUMENTS_TOOL_NAME = "list_instruments";

export type ListInstrumentsDeps = {
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

export type ListInstrumentsParams = {
  limit?: number;
};

export async function runListInstruments(
  params: ListInstrumentsParams,
  deps: ListInstrumentsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/catalogue/instruments`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-instruments",
  name: "VC Trader AI List Instruments",
  description: "Read-only catalogue listing of tradeable instruments.",
  tools: (tool) => [
    tool({
      name: LIST_INSTRUMENTS_TOOL_NAME,
      label: "List Instruments",
      description:
        "List tradeable instruments from the propfirm_manager core.instruments catalogue (instrument_id, symbol, description, is_active). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum rows to return (1..1000, default 300).",
            minimum: 1,
            maximum: 1000,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListInstruments(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
