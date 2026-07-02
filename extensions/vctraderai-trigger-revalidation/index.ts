import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: trigger_revalidation (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER executes the action directly. It POSTs to the
// BFF staged-action chokepoint `POST /api/v1/openclaw/stage` with
// `{ tool_name, workspace_id, params, summary }`. The BFF gates the tool against
// the closed-world allowlist, resolves the target_action_kind + confirm tier
// SERVER-SIDE from the allowlist spec, persists a reviewable staged descriptor,
// and returns it; the human reviews + Applies it in the chat.

export const TRIGGER_REVALIDATION_TOOL_NAME = "trigger_revalidation";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type TriggerRevalidationDeps = {
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

export type TriggerRevalidationParams = {
  strategy_id?: string;
  trader_def_id?: string;
  reason?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai trigger_revalidation: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: TriggerRevalidationParams): string {
  return `Revalidate strategy ${params.strategy_id ?? ""}`.trim();
}

export async function runTriggerRevalidation(
  params: TriggerRevalidationParams,
  deps: TriggerRevalidationDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: TRIGGER_REVALIDATION_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a trigger revalidation proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-trigger-revalidation",
  name: "VC Trader AI Trigger Revalidation (Propose)",
  description: "Stages a strategy-revalidation proposal for human review; never runs it directly.",
  tools: (tool) => [
    tool({
      name: TRIGGER_REVALIDATION_TOOL_NAME,
      label: "Trigger Revalidation",
      description:
        "Propose a strategy revalidation run. This STAGES a proposal for the human to review + Apply in the chat - it does NOT execute the action directly. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          strategy_id: Type.Optional(Type.String({ description: "Strategy id to revalidate." })),
          trader_def_id: Type.Optional(
            Type.String({ description: "Trader definition id to revalidate." }),
          ),
          reason: Type.Optional(
            Type.String({ description: "Why the revalidation is being proposed." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runTriggerRevalidation(
          params as TriggerRevalidationParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
