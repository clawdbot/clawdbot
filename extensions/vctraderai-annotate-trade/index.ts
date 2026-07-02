import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: annotate_trade (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER executes the action directly. It POSTs to the
// BFF staged-action chokepoint `POST /api/v1/openclaw/stage` with
// `{ tool_name, workspace_id, params, summary }`. The BFF gates the tool against
// the closed-world allowlist, resolves the target_action_kind + confirm tier
// SERVER-SIDE from the allowlist spec, persists a reviewable staged descriptor,
// and returns it; the human reviews + Applies it in the chat.

export const ANNOTATE_TRADE_TOOL_NAME = "annotate_trade";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type AnnotateTradeDeps = {
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

export type AnnotateTradeParams = {
  body: string;
  trade_source: string;
  source_run_id?: string;
  trade_key?: string;
  symbol?: string;
  trade_ts?: string;
  tags?: string[];
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai annotate_trade: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: AnnotateTradeParams): string {
  return `Annotate ${params.trade_source} trade`;
}

export async function runAnnotateTrade(
  params: AnnotateTradeParams,
  deps: AnnotateTradeDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: ANNOTATE_TRADE_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a annotate trade proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-annotate-trade",
  name: "VC Trader AI Annotate Trade (Propose)",
  description: "Stages a trade-annotation proposal for human review; never writes it directly.",
  tools: (tool) => [
    tool({
      name: ANNOTATE_TRADE_TOOL_NAME,
      label: "Annotate Trade",
      description:
        "Add a free-text annotation to a trade. This STAGES a proposal for the human to review + Apply in the chat - it does NOT execute the action directly. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          body: Type.String({ description: "Annotation text (required).", minLength: 1 }),
          trade_source: Type.String({
            description:
              "Which kind of trade the note hangs off (e.g. live, backtest, walkforward).",
            minLength: 1,
          }),
          source_run_id: Type.Optional(
            Type.String({ description: "Source run id the trade belongs to." }),
          ),
          trade_key: Type.Optional(
            Type.String({ description: "Stable key identifying the specific trade." }),
          ),
          symbol: Type.Optional(
            Type.String({ description: "Instrument symbol the trade traded." }),
          ),
          trade_ts: Type.Optional(Type.String({ description: "Trade timestamp (ISO-8601)." })),
          tags: Type.Optional(
            Type.Array(Type.String(), { description: "Optional free-form tags." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAnnotateTrade(
          params as AnnotateTradeParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
