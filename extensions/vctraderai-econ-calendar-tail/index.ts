import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: econ_calendar_tail.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `/api/v1/openclaw/data/econ-calendar/tail` endpoint and returns the raw
// envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.econ_calendar_tail` function (rows, schema,
// source, filters).

export const ECON_CALENDAR_TAIL_TOOL_NAME = "econ_calendar_tail";

export type EconCalendarTailDeps = {
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

export type EconCalendarTailParams = {
  n?: number;
};

export async function runEconCalendarTail(
  params: EconCalendarTailParams,
  deps: EconCalendarTailDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/econ-calendar/tail`, {
    query: {
      n: params.n !== undefined ? String(params.n) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-econ-calendar-tail",
  name: "VC Trader AI Econ Calendar Tail",
  description: "Read-only tail of recent economic-calendar events.",
  tools: (tool) => [
    tool({
      name: ECON_CALENDAR_TAIL_TOOL_NAME,
      label: "Econ Calendar Tail",
      description:
        "Return the last N economic-calendar events from the configured econ source (parquet file / QuestDB / Athena). Default N=50, max 500. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        n: Type.Optional(
          Type.Integer({
            description: "Number of tail events to return (default 50, server-bounded).",
            minimum: 1,
            maximum: 500,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEconCalendarTail(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
