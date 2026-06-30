import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_session_summary.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const GENERATE_SESSION_SUMMARY_TOOL_NAME = "generate_session_summary";

export type GenerateSessionSummaryDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type GenerateSessionSummaryParams = Record<string, unknown>;

function requireStringParam(params: GenerateSessionSummaryParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_session_summary: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: GenerateSessionSummaryParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runGenerateSessionSummary(
  params: GenerateSessionSummaryParams,
  deps: GenerateSessionSummaryDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch("/api/v1/openclaw/briefings/session-summary", {
    method: "GET",
    query: buildQuery(params, ["workspace_id", "session", "instrument"]),
    headers: { "X-OpenClaw-Tool": GENERATE_SESSION_SUMMARY_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-session-summary",
  name: "VC Trader AI Generate Session Summary",
  description: "Generate an offline session summary with freshness and stale labels.",
  tools: (tool) => [
    tool({
      name: GENERATE_SESSION_SUMMARY_TOOL_NAME,
      label: "Generate Session Summary",
      description: "Generate an offline session summary with freshness and stale labels.",
      parameters: Type.Object(
        {
          workspace_id: Type.String({ description: "Workspace id.", minLength: 1 }),
          session: Type.String({ description: "Session label.", minLength: 1 }),
          instrument: Type.Optional(Type.String({ description: "Instrument, e.g. XAUUSD." })),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateSessionSummary(
          params as GenerateSessionSummaryParams,
          {},
          context.signal,
        );
      },
    }),
  ],
});
