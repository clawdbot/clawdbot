import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardButton, buildFeishuCardInteractionContext } from "./card-ux-shared.js";

export const FEISHU_APPROVAL_REQUEST_ACTION = "feishu.quick_actions.request_approval";
export const FEISHU_APPROVAL_CONFIRM_ACTION = "feishu.approval.confirm";
export const FEISHU_APPROVAL_CANCEL_ACTION = "feishu.approval.cancel";

export function createApprovalCard(params: {
  operatorOpenId: string;
  chatId?: string;
  command: string;
  prompt: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
  confirmLabel?: string;
  cancelLabel?: string;
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
        content: "Confirm action",
      },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: params.prompt,
        },
        {
          tag: "action",
          actions: [
            buildFeishuCardButton({
              label: params.confirmLabel ?? "Confirm",
              type: "primary",
              value: createFeishuCardInteractionEnvelope({
                k: "quick",
                a: FEISHU_APPROVAL_CONFIRM_ACTION,
                q: params.command,
                c: context,
              }),
            }),
            buildFeishuCardButton({
              label: params.cancelLabel ?? "Cancel",
              value: createFeishuCardInteractionEnvelope({
                k: "button",
                a: FEISHU_APPROVAL_CANCEL_ACTION,
                c: context,
              }),
            }),
          ],
        },
      ],
    },
  };
}
