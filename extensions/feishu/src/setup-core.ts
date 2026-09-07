import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Feishu plugin module implements setup core behavior.
import {
  DEFAULT_ACCOUNT_ID,
  patchTopLevelChannelConfigSection,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultFeishuAccountId } from "./accounts.js";
import type { FeishuConfig } from "./types.js";

export function setFeishuNamedAccountEnabled(
  cfg: OpenClawConfig,
  accountId: string,
  enabled: boolean,
): OpenClawConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return patchTopLevelChannelConfigSection({
    cfg,
    channel: "feishu",
    patch: {
      accounts: {
        ...feishuCfg?.accounts,
        [accountId]: {
          ...feishuCfg?.accounts?.[accountId],
          enabled,
        },
      },
    },
  });
}

export const feishuSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultFeishuAccountId(cfg),
  applyAccountConfig: ({ cfg, accountId }) => {
    const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
    if (isDefault) {
      return setSetupChannelEnabled(cfg, "feishu", true);
    }
    return setFeishuNamedAccountEnabled(cfg, accountId, true);
  },
};

export const feishuSetupContract = defineChannelSetupContract({
  fields: {},
  legacyAdapter: feishuSetupAdapter,
});
