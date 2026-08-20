import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: send_notification (DIRECT_CONTROL).
//
// DIRECT_CONTROL per propfirm_manager core/openclaw/allowlist.py. This tool
// WRITES STRAIGHT THROUGH: it POSTs to the dedicated internal BFF route
// `POST /api/v1/openclaw/notifications/send` with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool, so the server-side allowlist
// gates the exact tool before running it. There is no staged descriptor and no
// human Apply click.
//
// History: this tool was PROPOSE_ONLY and posted to the generic
// `/api/v1/openclaw/stage` chokepoint. It flipped PROPOSE_ONLY ->
// DIRECT_CONTROL in propfirm_manager #1328 (2026-08-18) and this plugin never
// got the companion update every OTHER propose -> direct_control migration
// shipped with, so the BFF carried a hard-coded compatibility bridge
// (`_stage_direct_control_send_notification`) scoped to this one tool name to
// stop every live call 403ing. This is that companion update; the bridge is
// removed on the propfirm_manager side once the image carrying this plugin is
// baked and rolled.

export const SEND_NOTIFICATION_TOOL_NAME = "send_notification";
const SEND_PATH = "/api/v1/openclaw/notifications/send";

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

/**
 * One structured attachment riding ON the message. `kind` is a closed
 * vocabulary server-side (`web_api/notifications/inpage/schemas.py`), a list of
 * one today: "report".
 */
export type SendNotificationAttachment = {
  kind: "report";
  id: string;
};

export type SendNotificationParams = {
  title: string;
  body?: string;
  kind?: string;
  link_path?: string;
  attachments?: SendNotificationAttachment[];
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai send_notification: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runSendNotification(
  params: SendNotificationParams,
  deps: SendNotificationDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(SEND_PATH, {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": SEND_NOTIFICATION_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-send-notification",
  name: "VC Trader AI Send Notification",
  description:
    "Posts an in-page notification to the trader immediately through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: SEND_NOTIFICATION_TOOL_NAME,
      label: "Send Notification",
      description:
        "Surface an in-page notification to the trader. This writes STRAIGHT THROUGH - there is " +
        "no staged card and no Apply - and best-effort emails the trader if they opted in. " +
        "Deliver a published report by attaching its id, not by pasting the report into the " +
        "body: your message is the cover note, the report is the document.",
      parameters: Type.Object(
        {
          title: Type.String({ description: "Notification title. Required.", minLength: 1 }),
          body: Type.Optional(Type.String({ description: "Notification body text." })),
          kind: Type.Optional(
            Type.String({ description: "Severity: info, success, warning, or error." }),
          ),
          link_path: Type.Optional(
            Type.String({
              description: "In-app path the notification deep-links to.",
            }),
          ),
          attachments: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  kind: Type.Literal("report", {
                    description: "Attachment kind. Only 'report' is supported today.",
                  }),
                  id: Type.String({
                    description: "The report id returned by publish_report.",
                    minLength: 1,
                  }),
                },
                { additionalProperties: false },
              ),
              {
                description:
                  'Reports to deliver ON this message, e.g. [{"kind":"report","id":"<report_id>"}]. ' +
                  "Publish the report first and attach the id it returns.",
              },
            ),
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
