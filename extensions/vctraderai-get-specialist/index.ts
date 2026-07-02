import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_specialist.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it. The `specialist_key` is a PATH parameter
// (URL-encoded into the path); the route derives the workspace from the trusted
// container env, so this plugin sends NO body or query.

export const GET_SPECIALIST_TOOL_NAME = "get_specialist";

export type GetSpecialistDeps = {
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

export type GetSpecialistParams = Record<string, unknown>;

function requireStringParam(params: GetSpecialistParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_specialist: ${key} is required`);
  }
  return value;
}

export async function runGetSpecialist(
  params: GetSpecialistParams,
  deps: GetSpecialistDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const specialistKey = requireStringParam(params, "specialist_key");
  const path = `/api/v1/openclaw/specialists/${encodeURIComponent(specialistKey)}`;
  return bffFetch(path, {
    method: "GET",
    headers: { "X-OpenClaw-Tool": GET_SPECIALIST_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-specialist",
  name: "VC Trader AI Get Specialist",
  description:
    "Read a single Agent Alpha specialist by key through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: GET_SPECIALIST_TOOL_NAME,
      label: "Get Specialist",
      description:
        "Read a single Agent Alpha specialist by key through the guarded internal BFF route.",
      parameters: Type.Object(
        {
          specialist_key: Type.String({
            description: "Specialist key to read, e.g. gold_specialist.",
            minLength: 1,
          }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetSpecialist(
          params as GetSpecialistParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
