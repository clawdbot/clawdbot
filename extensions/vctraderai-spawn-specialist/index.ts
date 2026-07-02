import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: spawn_specialist.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it. The workspace, owner, and PM agent are
// SERVER-derived — this plugin MUST NOT send them in the body.

export const SPAWN_SPECIALIST_TOOL_NAME = "spawn_specialist";

export type SpawnSpecialistDeps = {
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

export type SpawnSpecialistParams = Record<string, unknown>;

export async function runSpawnSpecialist(
  params: SpawnSpecialistParams,
  deps: SpawnSpecialistDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/specialists/spawn", {
    method: "POST",
    body: { ...params },
    headers: { "X-OpenClaw-Tool": SPAWN_SPECIALIST_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-spawn-specialist",
  name: "VC Trader AI Spawn Specialist",
  description:
    "Spawn (invoke) an Agent Alpha specialist turn through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: SPAWN_SPECIALIST_TOOL_NAME,
      label: "Spawn Specialist",
      description:
        "Spawn (invoke) an Agent Alpha specialist turn through the guarded internal BFF route.",
      parameters: Type.Object(
        {
          specialist_key: Type.String({
            description: "Specialist key to spawn, e.g. gold_specialist.",
            minLength: 1,
          }),
          instrument: Type.Optional(
            Type.String({ description: "Instrument focus for this spawn, e.g. XAUUSD." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSpawnSpecialist(
          params as SpawnSpecialistParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
