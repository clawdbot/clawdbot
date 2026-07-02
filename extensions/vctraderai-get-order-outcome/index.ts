import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_order_outcome (agent-HONESTY order-outcome read-back).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped live read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope. The whole point: agent_place_order returns
// published_pending (the publish-accept), which is NOT a fill. The agent reads
// the TRUE terminal verdict back from the durable decision ledger before
// narrating a fill.

export const GET_ORDER_OUTCOME_TOOL_NAME = "get_order_outcome";

export type GetOrderOutcomeDeps = {
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

export type GetOrderOutcomeParams = {
  idempotency_key?: string;
  order_id?: string;
  client_order_id?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_order_outcome: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runGetOrderOutcome(
  params: GetOrderOutcomeParams,
  deps: GetOrderOutcomeDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const idempotencyKey = nonEmpty(params.idempotency_key);
  const orderId = nonEmpty(params.order_id);
  const clientOrderId = nonEmpty(params.client_order_id);
  // At least one handle is required (the BFF returns 400 otherwise); guard
  // here so a malformed call fails fast with a clear message instead of a 400.
  if (idempotencyKey === undefined && orderId === undefined && clientOrderId === undefined) {
    throw new Error(
      "vctraderai get_order_outcome: provide at least one of idempotency_key, order_id, or client_order_id",
    );
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/order-outcome`, {
    query: {
      idempotency_key: idempotencyKey,
      order_id: orderId,
      client_order_id: clientOrderId,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-order-outcome",
  name: "VC Trader AI Get Order Outcome",
  description:
    "Read-only workspace-scoped tool: the TRUE terminal outcome of an agent-placed order from the durable decision ledger via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_ORDER_OUTCOME_TOOL_NAME,
      label: "Get Order Outcome",
      description:
        'Confirm the TRUE terminal outcome of an agent-placed order from the durable decision ledger before telling the owner anything about a fill. ALWAYS call get_order_outcome to confirm the real terminal outcome (executed / rejected / gated / aborted) before saying an order filled — a place returns published_pending, which is NOT a fill, only "reached the queue". Provide at least one handle: idempotency_key (returned by agent_place_order), order_id, or client_order_id. Owner-scoped to the agent\'s own workspace. Returns the durable status — executed (the ONLY status that means filled), rejected (with rejection_reason), gated, aborted, downgraded, published_pending, pending (precommit only — node started, no verdict yet), or unknown (no ledger rows yet — common in the first moments after a place) — plus broker_order_id and deployment_mode when present. Treat published_pending, pending, AND unknown ALL as NOT-a-fill / keep-polling states: re-call get_order_outcome until you see a terminal status (executed / rejected / gated / aborted / downgraded). Never narrate a fill from published_pending, pending, unknown, or accepted_queued alone.',
      parameters: Type.Object({
        idempotency_key: Type.Optional(
          Type.String({
            description:
              "The idempotency_key returned by agent_place_order. Provide at least one of idempotency_key / order_id / client_order_id.",
          }),
        ),
        order_id: Type.Optional(
          Type.String({
            description:
              "The order id handle. Provide at least one of idempotency_key / order_id / client_order_id.",
          }),
        ),
        client_order_id: Type.Optional(
          Type.String({
            description:
              "The client_order_id handle. Provide at least one of idempotency_key / order_id / client_order_id.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetOrderOutcome(
          params as GetOrderOutcomeParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
