// WhatsApp side effects share the host session.sendPolicy decision.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveSessionOutboundPolicy,
  type SessionOutboundPolicyAction,
} from "openclaw/plugin-sdk/session-store-runtime";
import { isWhatsAppGroupJid, isWhatsAppNewsletterJid } from "./normalize.js";
import { toWhatsappJid } from "./text-runtime.js";

function resolveWhatsAppChatType(target: string): "direct" | "group" | "channel" {
  const jid = toWhatsappJid(target);
  if (isWhatsAppGroupJid(jid)) {
    return "group";
  }
  if (isWhatsAppNewsletterJid(jid)) {
    return "channel";
  }
  return "direct";
}

export function resolveWhatsAppOutboundPolicy(params: {
  cfg: OpenClawConfig;
  target: string;
  sessionKey?: string;
  action: SessionOutboundPolicyAction;
}) {
  return resolveSessionOutboundPolicy({
    cfg: params.cfg,
    action: params.action,
    sessionKey: params.sessionKey,
    channel: "whatsapp",
    chatType: resolveWhatsAppChatType(params.target),
  });
}

export function assertWhatsAppOutboundPolicyAllowed(params: {
  cfg: OpenClawConfig;
  target: string;
  sessionKey?: string;
  action: SessionOutboundPolicyAction;
}): void {
  const decision = resolveWhatsAppOutboundPolicy(params);
  if (decision.status === "allow") {
    return;
  }
  throw new PlatformMessageNotDispatchedError(
    `session.sendPolicy denied WhatsApp ${params.action}`,
    { cause: new Error(decision.reason), retryable: false },
  );
}
