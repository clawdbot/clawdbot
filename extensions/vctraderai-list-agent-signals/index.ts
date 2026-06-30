import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_agent_signals.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const LIST_AGENT_SIGNALS_TOOL_NAME = "list_agent_signals";

export type ListAgentSignalsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type ListAgentSignalsParams = Record<string, unknown>;

function requireStringParam(params: ListAgentSignalsParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai list_agent_signals: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: ListAgentSignalsParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runListAgentSignals(
  params: ListAgentSignalsParams,
  deps: ListAgentSignalsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch("/api/v1/openclaw/signals", {
    method: "GET",
    query: buildQuery(params, ["workspace_id", "status"]),
    headers: { "X-OpenClaw-Tool": LIST_AGENT_SIGNALS_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-agent-signals",
  name: "VC Trader AI List Agent Signals",
  description: "List specialist signals for Agent Alpha PM review.",
  tools: (tool) => [
    tool({
      name: LIST_AGENT_SIGNALS_TOOL_NAME,
      label: "List Agent Signals",
      description: "List specialist signals for Agent Alpha PM review.",
      parameters: Type.Object(
        {
          workspace_id: Type.String({ description: "Workspace id.", minLength: 1 }),
          status: Type.Optional(Type.String({ description: "Optional signal status filter." })),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListAgentSignals(params as ListAgentSignalsParams, {}, context.signal);
      },
    }),
  ],
});
