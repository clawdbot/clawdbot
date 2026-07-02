import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_specialist.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it. The workspace, owner, and PM agent are
// SERVER-derived (trusted env + service-context read) — this plugin MUST NOT
// send them in the body; the route ignores any body-supplied workspace_id.

export const CREATE_SPECIALIST_TOOL_NAME = "create_specialist";

export type CreateSpecialistDeps = {
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

export type CreateSpecialistParams = Record<string, unknown>;

export async function runCreateSpecialist(
  params: CreateSpecialistParams,
  deps: CreateSpecialistDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/specialists/create", {
    method: "POST",
    body: { ...params },
    headers: { "X-OpenClaw-Tool": CREATE_SPECIALIST_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-create-specialist",
  name: "VC Trader AI Create Specialist",
  description:
    "Register a persistent Agent Alpha specialist through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: CREATE_SPECIALIST_TOOL_NAME,
      label: "Create Specialist",
      description:
        "Register a persistent Agent Alpha specialist through the guarded internal BFF route.",
      parameters: Type.Object(
        {
          specialist_key: Type.String({
            description: "Unique specialist key to claim, e.g. gold_specialist.",
            minLength: 1,
          }),
          display_name: Type.Optional(Type.String({ description: "Human-friendly display name." })),
          brief: Type.Optional(
            Type.String({ description: "Instruction brief for the specialist." }),
          ),
          instrument: Type.Optional(Type.String({ description: "Instrument focus, e.g. XAUUSD." })),
          topic: Type.Optional(Type.String({ description: "Research topic focus." })),
          granted_tools: Type.Optional(
            Type.Array(Type.String(), { description: "Tools granted to this specialist." }),
          ),
          approval_class: Type.Optional(
            Type.String({ description: "Approval class, e.g. read_only." }),
          ),
          requested_model: Type.Optional(
            Type.String({ description: "Requested model id / route." }),
          ),
          cadence_seconds: Type.Optional(
            Type.Integer({
              description: "Heartbeat cadence in seconds (requires account_id).",
              minimum: 1,
            }),
          ),
          account_id: Type.Optional(
            Type.String({
              description: "Account id to bind the heartbeat to (required for cadence).",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateSpecialist(
          params as CreateSpecialistParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
