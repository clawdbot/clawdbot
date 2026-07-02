import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_session_playbook.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `POST /api/v1/openclaw/playbooks/session` endpoint which computes a
// per-trading-session playbook envelope (LONDON / NEW_YORK / TOKYO / etc.)
// from existing catalogue + economic-calendar data and returns it verbatim.
// No mutation - the BFF persists nothing on this path; the playbook is
// rebuilt on each call.

export const GENERATE_SESSION_PLAYBOOK_TOOL_NAME = "generate_session_playbook";

export type GenerateSessionPlaybookDeps = {
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

export type GenerateSessionPlaybookParams = {
  workspace_id: string;
  session: string;
};

export async function runGenerateSessionPlaybook(
  params: GenerateSessionPlaybookParams,
  deps: GenerateSessionPlaybookDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = {
    workspace_id: params.workspace_id,
    session: params.session,
  };
  return bffFetch("/api/v1/openclaw/playbooks/session", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-session-playbook",
  name: "VC Trader AI Generate Session Playbook",
  description: "Read-only generator for a per-session trading playbook.",
  tools: (tool) => [
    tool({
      name: GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
      label: "Generate Session Playbook",
      description:
        "Compute and return a session-scoped trading playbook envelope. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        session: Type.String({
          description:
            "Trading session identifier (e.g. LONDON, NEW_YORK, TOKYO). Must match a session enum returned by list_sessions.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateSessionPlaybook(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
