import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: emit_specialist_signal.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const EMIT_SPECIALIST_SIGNAL_TOOL_NAME = "emit_specialist_signal";

export type EmitSpecialistSignalDeps = {
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

export type EmitSpecialistSignalParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai emit_specialist_signal: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: EmitSpecialistSignalParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai emit_specialist_signal: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: EmitSpecialistSignalParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runEmitSpecialistSignal(
  params: EmitSpecialistSignalParams,
  deps: EmitSpecialistSignalDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/signals/emit", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": EMIT_SPECIALIST_SIGNAL_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-emit-specialist-signal",
  name: "VC Trader AI Emit Specialist Signal",
  description:
    "Emit a read-only specialist signal for Agent Alpha PM review; does not execute trades.",
  tools: (tool) => [
    tool({
      name: EMIT_SPECIALIST_SIGNAL_TOOL_NAME,
      label: "Emit Specialist Signal",
      description:
        "Emit a read-only specialist signal for Agent Alpha PM review; does not execute trades.",
      parameters: Type.Object(
        {
          specialist_key: Type.Optional(
            Type.String({ description: "Specialist key, usually gold_specialist." }),
          ),
          route_key: Type.Optional(Type.String({ description: "Model route key." })),
          requested_model: Type.Optional(Type.String({ description: "Requested model id." })),
          served_model: Type.Optional(Type.String({ description: "Served model id." })),
          instrument: Type.Optional(Type.String({ description: "Instrument, e.g. XAUUSD." })),
          topic: Type.Optional(Type.String({ description: "Signal topic." })),
          thesis: Type.String({ description: "Specialist thesis.", minLength: 1 }),
          confidence: Type.Number({
            description: "Confidence from 0 to 1.",
            minimum: 0,
            maximum: 1,
          }),
          horizon: Type.Optional(Type.String({ description: "Signal horizon." })),
          evidence: Type.Optional(Type.Record(Type.String(), Type.Any())),
          source_urls: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEmitSpecialistSignal(
          params as EmitSpecialistSignalParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
