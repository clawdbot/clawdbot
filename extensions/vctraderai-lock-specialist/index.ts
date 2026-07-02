import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: lock_specialist.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it. The workspace and owner are SERVER-derived —
// this plugin MUST NOT send them in the body.

export const LOCK_SPECIALIST_TOOL_NAME = "lock_specialist";

export type LockSpecialistDeps = {
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

export type LockSpecialistParams = Record<string, unknown>;

export async function runLockSpecialist(
  params: LockSpecialistParams,
  deps: LockSpecialistDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/specialists/lock", {
    method: "POST",
    body: { ...params },
    headers: { "X-OpenClaw-Tool": LOCK_SPECIALIST_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-lock-specialist",
  name: "VC Trader AI Lock Specialist",
  description: "Lock a specialist's execution (Layer B) through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: LOCK_SPECIALIST_TOOL_NAME,
      label: "Lock Specialist",
      description:
        "Lock a specialist's execution (Layer B) through the guarded internal BFF route.",
      parameters: Type.Object(
        {
          specialist_key: Type.String({
            description: "Specialist key to lock, e.g. gold_specialist.",
            minLength: 1,
          }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runLockSpecialist(
          params as LockSpecialistParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
