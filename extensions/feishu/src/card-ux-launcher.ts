import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { FEISHU_APPROVAL_REQUEST_ACTION } from "./card-ux-approval.js";
import { buildFeishuCardButton, buildFeishuCardInteractionContext } from "./card-ux-shared.js";
import { sendCardFeishu } from "./send.js";

const FEISHU_QUICK_ACTION_CARD_TTL_MS = 10 * 60_000;

const QUICK_ACTION_MENU_KEYS = new Set(["quick-actions", "quick_actions", "launcher"]);

export function isFeishuQuickActionMenuEventKey(eventKey: string): boolean {
  return QUICK_ACTION_MENU_KEYS.has(normalizeOptionalLowercaseString(eventKey) ?? "");
}

export function createQuickActionLauncherCard(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
}): Record<string, unknown> {
  const context = buildFeishuCardInteractionContext(params);
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Quick actions",
      },
      template: "indigo",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "Run common actions without typing raw commands.",
        },
        {
          tag: "action",
          actions: [
            buildFeishuCardButton({
              label: "Help",
              value: createFeishuCardInteractionEnvelope({
                k: "quick",
                a: "feishu.quick_actions.help",
                q: "/help",
                c: context,
              }),
            }),
            buildFeishuCardButton({
              label: "New session",
              type: "primary",
              value: createFeishuCardInteractionEnvelope({
                k: "meta",
                a: FEISHU_APPROVAL_REQUEST_ACTION,
                m: {
                  command: "/new",
                  prompt: "Start a fresh session? This will reset the current chat context.",
                },
                c: context,
              }),
            }),
            buildFeishuCardButton({
              label: "Reset",
              type: "danger",
              value: createFeishuCardInteractionEnvelope({
                k: "meta",
                a: FEISHU_APPROVAL_REQUEST_ACTION,
                m: {
                  command: "/reset",
                  prompt: "Reset this session now? Any active conversation state will be cleared.",
                },
                c: context,
              }),
            }),
          ],
        },
      ],
    },
  };
}

export async function maybeHandleFeishuQuickActionMenu(params: {
  cfg: ClawdbotConfig;
  eventKey: string;
  operatorOpenId: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  now?: number;
}): Promise<boolean> {
  if (!isFeishuQuickActionMenuEventKey(params.eventKey)) {
    return false;
  }

  const expiresAt = (params.now ?? Date.now()) + FEISHU_QUICK_ACTION_CARD_TTL_MS;
  try {
    await sendCardFeishu({
      cfg: params.cfg,
      to: `user:${params.operatorOpenId}`,
      card: createQuickActionLauncherCard({
        operatorOpenId: params.operatorOpenId,
        expiresAt,
        chatType: "p2p",
      }),
      accountId: params.accountId,
    });
  } catch (err) {
    params.runtime?.log?.(
      `feishu[${params.accountId ?? "default"}]: failed to open quick-action launcher for ${params.operatorOpenId}: ${String(err)}`,
    );
    return false;
  }
  params.runtime?.log?.(
    `feishu[${params.accountId ?? "default"}]: opened quick-action launcher for ${params.operatorOpenId}`,
  );
  return true;
}
