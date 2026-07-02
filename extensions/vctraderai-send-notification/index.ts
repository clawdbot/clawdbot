import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: send_notification (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER executes the action directly. It POSTs to the
// BFF staged-action chokepoint `POST /api/v1/openclaw/stage` with
// `{ tool_name, workspace_id, params, summary }`. The BFF gates the tool against
// the closed-world allowlist, resolves the target_action_kind + confirm tier
// SERVER-SIDE from the allowlist spec, persists a reviewable staged descriptor,
// and returns it; the human reviews + Applies it in the chat.

export const SEND_NOTIFICATION_TOOL_NAME = "send_notification";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type SendNotificationDeps = {
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

export type SendNotificationParams = {
  title: string;
  body?: string;
  kind?: string;
  link_path?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai send_notification: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: SendNotificationParams): string {
  return `Notify: ${params.title}`;
}

export async function runSendNotification(
  params: SendNotificationParams,
  deps: SendNotificationDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: SEND_NOTIFICATION_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a send notification proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-send-notification",
  name: "VC Trader AI Send Notification (Propose)",
  description: "Stages an in-page notification proposal for human review; never sends it directly.",
  tools: (tool) => [
    tool({
      name: SEND_NOTIFICATION_TOOL_NAME,
      label: "Send Notification",
      description:
        "Surface an in-page notification to the user. This STAGES a proposal for the human to review + Apply in the chat - it does NOT execute the action directly. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          title: Type.String({ description: "Notification title (required).", minLength: 1 }),
          body: Type.Optional(Type.String({ description: "Notification body text." })),
          kind: Type.Optional(
            Type.String({ description: "Notification kind (e.g. info, warning, success)." }),
          ),
          link_path: Type.Optional(
            Type.String({
              description: "Optional in-app link path the notification deep-links to.",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSendNotification(
          params as SendNotificationParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
