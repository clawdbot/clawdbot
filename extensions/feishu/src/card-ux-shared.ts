import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";

export function buildFeishuCardButton(params: {
  label: string;
  value: FeishuCardInteractionEnvelope;
  type?: "default" | "primary" | "danger";
}) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.label,
    },
    type: params.type ?? "default",
    value: params.value,
  };
}

export function buildFeishuCardInteractionContext(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
}) {
  return {
    u: params.operatorOpenId,
    ...(params.chatId ? { h: params.chatId } : {}),
    ...(params.sessionKey ? { s: params.sessionKey } : {}),
    e: params.expiresAt,
    ...(params.chatType ? { t: params.chatType } : {}),
  };
}
