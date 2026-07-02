import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_live_quotes.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_LIVE_QUOTES_TOOL_NAME = "get_live_quotes";

export type GetLiveQuotesDeps = {
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

export type GetLiveQuotesParams = {
  account_id: string;
  symbols: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_live_quotes: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetLiveQuotes(
  params: GetLiveQuotesParams,
  deps: GetLiveQuotesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/quotes`, {
    query: {
      account_id: params.account_id,
      symbols: params.symbols,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-live-quotes",
  name: "VC Trader AI Get Live Quotes",
  description:
    "Read-only workspace-scoped tool: Current live bid/ask for one or more symbols directly from the live broker via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_LIVE_QUOTES_TOOL_NAME,
      label: "Get Live Quotes",
      description:
        "Current live bid/ask for one or more symbols DIRECTLY from the live broker. Required: symbols (comma-separated), account_id.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read quotes for.",
          minLength: 1,
        }),
        symbols: Type.String({
          description: "Comma-separated symbols, e.g. EURUSD,XAUUSD.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetLiveQuotes(
          params as GetLiveQuotesParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
