import type { ClawdbotConfig } from "../config/config.js";
import { hasAnyWhatsAppAuth } from "../web/accounts.js";

export function normalizeLegacyConfigValues(cfg: ClawdbotConfig): {
  config: ClawdbotConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: ClawdbotConfig = cfg;

  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  const hasWhatsAppConfig = cfg.channels?.whatsapp !== undefined;
  const hasWhatsAppAuth = hasAnyWhatsAppAuth(cfg);
  if (legacyAckReaction && (hasWhatsAppConfig || hasWhatsAppAuth)) {
    const hasWhatsAppAck = cfg.channels?.whatsapp?.ackReaction !== undefined;
    if (!hasWhatsAppAck) {
      const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      let direct = true;
      let group: "always" | "mentions" | "never" = "mentions";
      if (legacyScope === "all") {
        direct = true;
        group = "always";
      } else if (legacyScope === "direct") {
        direct = true;
        group = "never";
      } else if (legacyScope === "group-all") {
        direct = false;
        group = "always";
      } else if (legacyScope === "group-mentions") {
        direct = false;
        group = "mentions";
      }
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            ackReaction: { emoji: legacyAckReaction, direct, group },
          },
        },
      };
      changes.push(
        `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
      );
    }
  }

  return { config: next, changes };
}
