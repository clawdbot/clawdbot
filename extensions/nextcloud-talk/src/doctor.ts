import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { listNextcloudTalkAccountIds, resolveNextcloudTalkAccount } from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import {
  legacyConfigRules as NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeNextcloudTalkCompatibilityConfig,
} from "./doctor-contract.js";
import type { CoreConfig } from "./types.js";

async function collectNextcloudTalkBotResponseWarnings(params: {
  cfg: CoreConfig;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const account = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !account.secret || !account.baseUrl) {
      continue;
    }
    const result = await probeNextcloudTalkBotResponseFeature({
      account,
      timeoutMs: 5_000,
    });
    if (
      result.code === "missing_response_feature" ||
      result.code === "bot_not_found" ||
      result.code === "api_error" ||
      result.code === "request_failed"
    ) {
      warnings.push(`- channels.nextcloud-talk.${account.accountId}: ${result.message}`);
    }
  }
  return warnings;
}

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeNextcloudTalkCompatibilityConfig,
  collectPreviewWarnings: async ({ cfg }) =>
    await collectNextcloudTalkBotResponseWarnings({ cfg: cfg as CoreConfig }),
};
