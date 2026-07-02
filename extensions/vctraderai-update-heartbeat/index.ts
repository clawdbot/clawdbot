import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: update_heartbeat.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const UPDATE_HEARTBEAT_TOOL_NAME = "update_heartbeat";

export type UpdateHeartbeatDeps = {
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

export type UpdateHeartbeatParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai update_heartbeat: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: UpdateHeartbeatParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai update_heartbeat: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: UpdateHeartbeatParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runUpdateHeartbeat(
  params: UpdateHeartbeatParams,
  deps: UpdateHeartbeatDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/update", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": UPDATE_HEARTBEAT_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-update-heartbeat",
  name: "VC Trader AI Update Heartbeat",
  description:
    "Update cadence, timeout, route, symbols, or instructions for an existing Agent Alpha heartbeat policy.",
  tools: (tool) => [
    tool({
      name: UPDATE_HEARTBEAT_TOOL_NAME,
      label: "Update Heartbeat",
      description:
        "Update cadence, timeout, route, symbols, or instructions for an existing Agent Alpha heartbeat policy.",
      parameters: Type.Object(
        {
          policy_id: Type.String({ description: "Heartbeat policy id.", minLength: 1 }),
          cadence_seconds: Type.Optional(
            Type.Integer({ description: "Heartbeat cadence in seconds.", minimum: 1 }),
          ),
          turn_timeout_seconds: Type.Optional(
            Type.Integer({ description: "Per-turn timeout in seconds.", minimum: 1 }),
          ),
          model_route_key: Type.Optional(
            Type.String({ description: "Model route key, usually heartbeat." }),
          ),
          instructions: Type.Optional(Type.String({ description: "Heartbeat instructions." })),
          price_symbols: Type.Optional(Type.Array(Type.String())),
          provider_config: Type.Optional(Type.Record(Type.String(), Type.Any())),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runUpdateHeartbeat(
          params as UpdateHeartbeatParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
