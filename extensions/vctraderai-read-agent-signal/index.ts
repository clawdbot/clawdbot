import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: read_agent_signal.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const READ_AGENT_SIGNAL_TOOL_NAME = "read_agent_signal";

export type ReadAgentSignalDeps = {
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

export type ReadAgentSignalParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai read_agent_signal: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: ReadAgentSignalParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai read_agent_signal: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: ReadAgentSignalParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runReadAgentSignal(
  params: ReadAgentSignalParams,
  deps: ReadAgentSignalDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/signals/${requireStringParam(params, "signal_id")}`, {
    method: "GET",
    query: buildQuery({ ...params, workspace_id: readWorkspaceId() }, ["workspace_id"]),
    headers: { "X-OpenClaw-Tool": READ_AGENT_SIGNAL_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-read-agent-signal",
  name: "VC Trader AI Read Agent Signal",
  description: "Read one specialist signal by id for Agent Alpha PM review.",
  tools: (tool) => [
    tool({
      name: READ_AGENT_SIGNAL_TOOL_NAME,
      label: "Read Agent Signal",
      description: "Read one specialist signal by id for Agent Alpha PM review.",
      parameters: Type.Object(
        {
          signal_id: Type.String({ description: "Signal id.", minLength: 1 }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runReadAgentSignal(
          params as ReadAgentSignalParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
