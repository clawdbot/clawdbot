import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_heartbeat_status.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const GET_HEARTBEAT_STATUS_TOOL_NAME = "get_heartbeat_status";

export type GetHeartbeatStatusDeps = {
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

export type GetHeartbeatStatusParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_heartbeat_status: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: GetHeartbeatStatusParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_heartbeat_status: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: GetHeartbeatStatusParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runGetHeartbeatStatus(
  params: GetHeartbeatStatusParams,
  deps: GetHeartbeatStatusDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/status", {
    method: "GET",
    query: buildQuery({ ...params, workspace_id: readWorkspaceId() }, [
      "workspace_id",
      "policy_id",
    ]),
    headers: { "X-OpenClaw-Tool": GET_HEARTBEAT_STATUS_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-heartbeat-status",
  name: "VC Trader AI Get Heartbeat Status",
  description:
    "Read heartbeat status, cadence, timeout, route, failure streak, last failure, and next due time.",
  tools: (tool) => [
    tool({
      name: GET_HEARTBEAT_STATUS_TOOL_NAME,
      label: "Get Heartbeat Status",
      description:
        "Read heartbeat status, cadence, timeout, route, failure streak, last failure, and next due time.",
      parameters: Type.Object(
        {
          policy_id: Type.String({ description: "Heartbeat policy id.", minLength: 1 }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetHeartbeatStatus(
          params as GetHeartbeatStatusParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
