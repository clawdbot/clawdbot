// Synology Chat plugin module reports attachment-route setup gaps without blocking text/inbound use.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { resolveSynologyHostedMediaRoute } from "./hosted-media-route.js";

export const synologyChatDoctor: ChannelDoctorAdapter = {
  collectPreviewWarnings: ({ cfg }) => {
    const warnings: string[] = [];
    for (const accountId of listAccountIds(cfg)) {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled || !account.token || !account.incomingUrl) {
        continue;
      }
      try {
        resolveSynologyHostedMediaRoute(account);
      } catch (error) {
        warnings.push(
          `- channels.synology-chat${
            accountId === "default" ? "" : `.accounts.${accountId}`
          }.webhookUrl: attachments are unavailable; ${
            error instanceof Error ? error.message : String(error)
          } Text and inbound messages are unaffected.`,
        );
      }
    }
    return warnings;
  },
};
