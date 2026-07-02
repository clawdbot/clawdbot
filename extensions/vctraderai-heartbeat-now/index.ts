import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: heartbeat_now.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const HEARTBEAT_NOW_TOOL_NAME = "heartbeat_now";

export type HeartbeatNowDeps = {
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

export type HeartbeatNowParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai heartbeat_now: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: HeartbeatNowParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai heartbeat_now: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: HeartbeatNowParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runHeartbeatNow(
  params: HeartbeatNowParams,
  deps: HeartbeatNowDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/now", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": HEARTBEAT_NOW_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-heartbeat-now",
  name: "VC Trader AI Heartbeat Now",
  description:
    "Mark an Agent Alpha heartbeat policy due now without bypassing the normal heartbeat runner gates.",
  tools: (tool) => [
    tool({
      name: HEARTBEAT_NOW_TOOL_NAME,
      label: "Heartbeat Now",
      description:
        "Mark an Agent Alpha heartbeat policy due now without bypassing the normal heartbeat runner gates.",
      parameters: Type.Object(
        {
          policy_id: Type.String({ description: "Heartbeat policy id.", minLength: 1 }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runHeartbeatNow(
          params as HeartbeatNowParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
