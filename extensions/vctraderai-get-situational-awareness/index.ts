import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_situational_awareness.
//
// READ_ONLY per ADR 0078. Calls the propfirm_manager internal OpenClaw BFF
// route GET /api/v1/openclaw/situational-awareness with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist
// gates the exact tool before running it. Returns the per-turn
// situational-awareness snapshot (risk-budget, market regime, econ-news
// proximity, account-health) with honesty/staleness labels. Offline, no
// broker read.

export const GET_SITUATIONAL_AWARENESS_TOOL_NAME = "get_situational_awareness";

export type GetSituationalAwarenessDeps = {
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

export type GetSituationalAwarenessParams = {
  account_id?: string;
  instrument?: string;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_situational_awareness: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildQuery(params: GetSituationalAwarenessParams): Record<string, string | undefined> {
  return {
    workspace_id: readWorkspaceId(),
    account_id: typeof params.account_id === "string" ? params.account_id : undefined,
    instrument: typeof params.instrument === "string" ? params.instrument : undefined,
  };
}

export async function runGetSituationalAwareness(
  params: GetSituationalAwarenessParams,
  deps: GetSituationalAwarenessDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/situational-awareness", {
    method: "GET",
    query: buildQuery(params),
    headers: { "X-OpenClaw-Tool": GET_SITUATIONAL_AWARENESS_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-situational-awareness",
  name: "VC Trader AI Get Situational Awareness",
  description:
    "Per-turn situational-awareness snapshot: risk-budget, market regime, econ-news proximity, and account-health with honesty/staleness labels (read-only, offline, no broker read).",
  tools: (tool) => [
    tool({
      name: GET_SITUATIONAL_AWARENESS_TOOL_NAME,
      label: "Get Situational Awareness",
      description:
        "Return a per-turn situational-awareness snapshot (risk-budget headroom, market regime, econ-news proximity, account-health) with honesty/staleness labels. Optional account_id scopes account-health and instrument narrows regime/econ context. READ_ONLY per ADR 0078 - no mutation, offline, no broker read.",
      parameters: Type.Object({
        account_id: Type.Optional(
          Type.String({
            description: "Account id to scope the account-health rollup (optional).",
            minLength: 1,
          }),
        ),
        instrument: Type.Optional(
          Type.String({
            description: "Instrument, e.g. XAUUSD, to narrow regime/econ context (optional).",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetSituationalAwareness(
          params as GetSituationalAwarenessParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
