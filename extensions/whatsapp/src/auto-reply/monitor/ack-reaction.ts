// Whatsapp plugin module implements ack reaction behavior.
import {
  createAckReactionHandle,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import { resolveWhatsAppReactionEligibility } from "./reaction-eligibility.js";

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  const eligibility = await resolveWhatsAppReactionEligibility({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    verbose: params.verbose,
  });
  if (eligibility.status === "disabled") {
    return null;
  }
  const { chatId, messageId, emoji, reactionOptions } = eligibility;

  params.info({ chatId, messageId, emoji }, "sending ack reaction");
  return createAckReactionHandle({
    ackReactionValue: emoji,
    send: () => sendReactionWhatsApp(chatId, messageId, emoji, reactionOptions),
    remove: () => sendReactionWhatsApp(chatId, messageId, "", reactionOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId,
          messageId,
        },
        "failed to send ack reaction",
      );
      logVerbose(`WhatsApp ack reaction failed for chat ${chatId}: ${formatError(err)}`);
    },
  });
}
