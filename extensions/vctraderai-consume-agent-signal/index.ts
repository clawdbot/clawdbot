import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: consume_agent_signal.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const CONSUME_AGENT_SIGNAL_TOOL_NAME = "consume_agent_signal";

export type ConsumeAgentSignalDeps = {
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

export type ConsumeAgentSignalParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai consume_agent_signal: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: ConsumeAgentSignalParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai consume_agent_signal: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: ConsumeAgentSignalParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runConsumeAgentSignal(
  params: ConsumeAgentSignalParams,
  deps: ConsumeAgentSignalDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/signals/consume", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": CONSUME_AGENT_SIGNAL_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-consume-agent-signal",
  name: "VC Trader AI Consume Agent Signal",
  description: "Mark one specialist signal consumed by the Agent Alpha PM thread.",
  tools: (tool) => [
    tool({
      name: CONSUME_AGENT_SIGNAL_TOOL_NAME,
      label: "Consume Agent Signal",
      description: "Mark one specialist signal consumed by the Agent Alpha PM thread.",
      parameters: Type.Object(
        {
          signal_id: Type.String({ description: "Signal id.", minLength: 1 }),
          consumed_by_thread_id: Type.Optional(
            Type.String({ description: "Consuming PM thread id." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runConsumeAgentSignal(
          params as ConsumeAgentSignalParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
