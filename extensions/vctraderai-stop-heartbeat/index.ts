import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: stop_heartbeat.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const STOP_HEARTBEAT_TOOL_NAME = "stop_heartbeat";

export type StopHeartbeatDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type StopHeartbeatParams = Record<string, unknown>;

function requireStringParam(params: StopHeartbeatParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai stop_heartbeat: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: StopHeartbeatParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runStopHeartbeat(
  params: StopHeartbeatParams,
  deps: StopHeartbeatDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch("/api/v1/openclaw/heartbeat/stop", {
    method: "POST",
    body: params,
    headers: { "X-OpenClaw-Tool": STOP_HEARTBEAT_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-stop-heartbeat",
  name: "VC Trader AI Stop Heartbeat",
  description: "Stop an Agent Alpha heartbeat policy without deleting its history.",
  tools: (tool) => [
    tool({
      name: STOP_HEARTBEAT_TOOL_NAME,
      label: "Stop Heartbeat",
      description: "Stop an Agent Alpha heartbeat policy without deleting its history.",
      parameters: Type.Object(
        {
          workspace_id: Type.String({ description: "Workspace id.", minLength: 1 }),
          policy_id: Type.String({ description: "Heartbeat policy id.", minLength: 1 }),
          stopped_by_user_id: Type.Optional(
            Type.String({ description: "User id requesting stop." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runStopHeartbeat(params as StopHeartbeatParams, {}, context.signal);
      },
    }),
  ],
});
