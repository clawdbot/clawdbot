// Whatsapp plugin module implements status reaction behavior.
import {
  createStatusReactionController,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { sendReactionWhatsApp } from "../../send.js";
import { resolveWhatsAppReactionEligibility } from "./reaction-eligibility.js";

export type { StatusReactionController };

type WhatsAppStatusReactionParams = {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
};

export async function createWhatsAppStatusReactionController(
  params: WhatsAppStatusReactionParams,
): Promise<StatusReactionController | null> {
  if (!params.msg.event.id) {
    return null;
  }

  const statusReactionsConfig = params.cfg.messages?.statusReactions;
  if (statusReactionsConfig?.enabled !== true) {
    return null;
  }

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
  const { chatId, messageId, emoji: initialEmoji, reactionOptions } = eligibility;

  return createStatusReactionController({
    enabled: true,
    adapter: {
      setReaction: async (emoji: string) => {
        await sendReactionWhatsApp(chatId, messageId, emoji, reactionOptions);
      },
      clearReaction: async () => {
        await sendReactionWhatsApp(chatId, messageId, "", reactionOptions);
      },
    },
    initialEmoji,
    emojis: undefined,
    onError: (err) => {
      logVerbose(`WhatsApp status-reaction error for chat ${chatId}/${messageId}: ${String(err)}`);
    },
  });
}
