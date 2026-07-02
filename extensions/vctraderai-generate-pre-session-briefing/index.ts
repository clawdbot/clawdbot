import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_pre_session_briefing.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const GENERATE_PRE_SESSION_BRIEFING_TOOL_NAME = "generate_pre_session_briefing";

export type GeneratePreSessionBriefingDeps = {
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

export type GeneratePreSessionBriefingParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_pre_session_briefing: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: GeneratePreSessionBriefingParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_pre_session_briefing: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: GeneratePreSessionBriefingParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runGeneratePreSessionBriefing(
  params: GeneratePreSessionBriefingParams,
  deps: GeneratePreSessionBriefingDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/briefings/pre-session", {
    method: "GET",
    query: buildQuery({ ...params, workspace_id: readWorkspaceId() }, [
      "workspace_id",
      "session",
      "instrument",
    ]),
    headers: { "X-OpenClaw-Tool": GENERATE_PRE_SESSION_BRIEFING_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-pre-session-briefing",
  name: "VC Trader AI Generate Pre-Session Briefing",
  description:
    "Generate an offline pre-session briefing with offline_mode true and metaapi_used false.",
  tools: (tool) => [
    tool({
      name: GENERATE_PRE_SESSION_BRIEFING_TOOL_NAME,
      label: "Generate Pre-Session Briefing",
      description:
        "Generate an offline pre-session briefing with offline_mode true and metaapi_used false.",
      parameters: Type.Object(
        {
          session: Type.String({ description: "Session label.", minLength: 1 }),
          instrument: Type.Optional(Type.String({ description: "Instrument, e.g. XAUUSD." })),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGeneratePreSessionBriefing(
          params as GeneratePreSessionBriefingParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
