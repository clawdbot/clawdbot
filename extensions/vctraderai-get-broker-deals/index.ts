import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_broker_deals.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_BROKER_DEALS_TOOL_NAME = "get_broker_deals";

export type GetBrokerDealsDeps = {
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

export type GetBrokerDealsParams = {
  account_id: string;
  hours?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_broker_deals: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetBrokerDeals(
  params: GetBrokerDealsParams,
  deps: GetBrokerDealsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/deals`, {
    query: {
      account_id: params.account_id,
      hours: params.hours !== undefined ? String(params.hours) : "24",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-broker-deals",
  name: "VC Trader AI Get Broker Deals",
  description:
    "Read-only workspace-scoped tool: Recent deals/fills directly from the broker's own deal history via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_BROKER_DEALS_TOOL_NAME,
      label: "Get Broker Deals",
      description:
        "Recent deals/fills DIRECTLY from the broker's own deal history. Required: account_id. Optional: hours (default 24, max 720).",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read broker deals for.",
          minLength: 1,
        }),
        hours: Type.Optional(
          Type.Integer({ description: "Lookback window in hours.", minimum: 1, maximum: 720 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetBrokerDeals(
          params as GetBrokerDealsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
