import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: enable_heartbeat.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const ENABLE_HEARTBEAT_TOOL_NAME = "enable_heartbeat";

export type EnableHeartbeatDeps = {
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

export type EnableHeartbeatParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai enable_heartbeat: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: EnableHeartbeatParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai enable_heartbeat: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: EnableHeartbeatParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runEnableHeartbeat(
  params: EnableHeartbeatParams,
  deps: EnableHeartbeatDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/enable", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": ENABLE_HEARTBEAT_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-enable-heartbeat",
  name: "VC Trader AI Enable Heartbeat",
  description:
    "Enable or update an Agent Alpha heartbeat policy through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: ENABLE_HEARTBEAT_TOOL_NAME,
      label: "Enable Heartbeat",
      description:
        "Enable or update an Agent Alpha heartbeat policy through the guarded internal BFF route.",
      parameters: Type.Object(
        {
          thread_id: Type.Optional(Type.String({ description: "Thread id to heartbeat." })),
          account_id: Type.String({ description: "Account id to monitor.", minLength: 1 }),
          cadence_seconds: Type.Integer({
            description: "Heartbeat cadence in seconds.",
            minimum: 1,
          }),
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
        return runEnableHeartbeat(
          params as EnableHeartbeatParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
