import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveMergedAccountConfig } from "./channel-account-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type ChannelGroupConfig = {
  requireMention?: boolean;
  ingest?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type ChannelGroups = Record<string, ChannelGroupConfig>;

export function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: ChannelId,
  accountId?: string | null,
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig:
    | {
        accounts?: Record<string, { groups?: ChannelGroups }>;
        groups?: ChannelGroups;
      }
    | undefined = cfg.channels?.[channel];
  if (!channelConfig) {
    return undefined;
  }
  // Single-account empty maps inherit; in multi-account setups they opt out.
  return resolveMergedAccountConfig({
    channelConfig,
    accounts: channelConfig.accounts,
    accountId: normalizedAccountId,
    inheritEmptyKeys:
      Object.keys(channelConfig.accounts ?? {}).length > 1 ? {} : { groups: "object" },
  }).groups;
}
