import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
} from "openclaw/plugin-sdk/ssrf-runtime";

type TlonAccountConfig = {
  name?: string;
  enabled?: boolean;
  ship?: string;
  url?: string;
  code?: string;
  network?: {
    dangerouslyAllowPrivateNetwork?: boolean;
  };
  groupChannels?: string[];
  dmAllowlist?: string[];
  groupInviteAllowlist?: string[];
  autoDiscoverChannels?: boolean;
  showModelSignature?: boolean;
  autoAcceptDmInvites?: boolean;
  autoAcceptGroupInvites?: boolean;
  defaultAuthorizedShips?: string[];
  ownerShip?: string;
  accounts?: Record<string, TlonAccountConfig>;
};

export type TlonResolvedAccount = {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  ship: string | null;
  url: string | null;
  code: string | null;
  dangerouslyAllowPrivateNetwork: boolean | null;
  groupChannels: string[];
  dmAllowlist: string[];
  /** Ships allowed to invite us to groups (security: prevent malicious group invites) */
  groupInviteAllowlist: string[];
  autoDiscoverChannels: boolean | null;
  showModelSignature: boolean | null;
  autoAcceptDmInvites: boolean | null;
  autoAcceptGroupInvites: boolean | null;
  defaultAuthorizedShips: string[];
  /** Ship that receives approval requests for DMs, channel mentions, and group invites */
  ownerShip: string | null;
};

function resolveTlonChannelConfig(cfg: OpenClawConfig): TlonAccountConfig | undefined {
  return cfg.channels?.tlon as TlonAccountConfig | undefined;
}

function resolveMergedTlonAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> & TlonAccountConfig {
  const channel = resolveTlonChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return (channel ?? {}) as Record<string, unknown> & TlonAccountConfig;
  }
  return resolveMergedAccountConfig<Record<string, unknown> & TlonAccountConfig>({
    channelConfig: (channel ?? {}) as Record<string, unknown> & TlonAccountConfig,
    accounts: channel?.accounts as
      | Record<string, Partial<Record<string, unknown> & TlonAccountConfig>>
      | undefined,
    accountId,
    normalizeAccountId,
  });
}

export function resolveTlonAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TlonResolvedAccount {
  const resolvedAccountId = normalizeAccountId(accountId);
  const base = resolveTlonChannelConfig(cfg);

  if (!base) {
    return {
      accountId: resolvedAccountId,
      name: null,
      enabled: false,
      configured: false,
      ship: null,
      url: null,
      code: null,
      dangerouslyAllowPrivateNetwork: null,
      groupChannels: [],
      dmAllowlist: [],
      groupInviteAllowlist: [],
      autoDiscoverChannels: null,
      showModelSignature: null,
      autoAcceptDmInvites: null,
      autoAcceptGroupInvites: null,
      defaultAuthorizedShips: [],
      ownerShip: null,
    };
  }

  const merged = resolveMergedTlonAccountConfig(cfg, resolvedAccountId);
  const ship = merged.ship ?? null;
  const url = merged.url ?? null;
  const code = merged.code ?? null;
  const dangerouslyAllowPrivateNetwork = isPrivateNetworkOptInEnabled(merged)
    ? true
    : typeof merged.network?.dangerouslyAllowPrivateNetwork === "boolean"
      ? merged.network.dangerouslyAllowPrivateNetwork
      : hasLegacyFlatAllowPrivateNetworkAlias(merged) &&
          typeof merged.allowPrivateNetwork === "boolean"
        ? merged.allowPrivateNetwork
        : null;
  const groupChannels = merged.groupChannels ?? [];
  const dmAllowlist = merged.dmAllowlist ?? [];
  const groupInviteAllowlist = merged.groupInviteAllowlist ?? [];
  const autoDiscoverChannels = merged.autoDiscoverChannels ?? null;
  const showModelSignature = merged.showModelSignature ?? null;
  const autoAcceptDmInvites = merged.autoAcceptDmInvites ?? null;
  const autoAcceptGroupInvites = merged.autoAcceptGroupInvites ?? null;
  const ownerShip = merged.ownerShip ?? null;
  const defaultAuthorizedShips = merged.defaultAuthorizedShips ?? [];
  const configured = Boolean(ship && url && code);

  return {
    accountId: resolvedAccountId,
    name: merged.name ?? null,
    enabled: merged.enabled !== false,
    configured,
    ship,
    url,
    code,
    dangerouslyAllowPrivateNetwork,
    groupChannels,
    dmAllowlist,
    groupInviteAllowlist,
    autoDiscoverChannels,
    showModelSignature,
    autoAcceptDmInvites,
    autoAcceptGroupInvites,
    defaultAuthorizedShips,
    ownerShip,
  };
}

export function listTlonAccountIds(cfg: OpenClawConfig): string[] {
  const base = resolveTlonChannelConfig(cfg);
  if (!base) {
    return [];
  }
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(base.accounts ?? {}).map(normalizeAccountId),
    implicitAccountId: base.ship ? DEFAULT_ACCOUNT_ID : undefined,
  });
}
