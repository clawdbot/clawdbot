import {
  createAccountListHelpers,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/account-helpers";
// Tlon type declarations define plugin contracts.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
} from "openclaw/plugin-sdk/ssrf-runtime";

type TlonAccountConfig = {
  /** Megabyte cap for media this channel accepts and delivers. */
  mediaMaxMb?: number;
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
  implicitMentions?: Partial<ResolvedChannelImplicitMentions>;
  accounts?: Record<string, TlonAccountConfig>;
};

export type TlonResolvedAccount = {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  mediaMaxBytes?: number;
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

const {
  listAccountIds: listTlonAccountIds,
  resolveAccountConfig: resolveMergedNamedTlonAccountConfig,
} = createAccountListHelpers<TlonAccountConfig>("tlon", {
  normalizeAccountId,
  fallbackAccountIdWhenEmpty: false,
  hasImplicitDefaultAccount: (cfg) => Boolean(resolveTlonChannelConfig(cfg)?.ship),
});

export { listTlonAccountIds };

function resolveMergedTlonAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> & TlonAccountConfig {
  const channel = resolveTlonChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return (channel ?? {}) as Record<string, unknown> & TlonAccountConfig;
  }
  return resolveMergedNamedTlonAccountConfig(cfg, accountId) as Record<string, unknown> &
    TlonAccountConfig;
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
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg,
      accountId: resolvedAccountId,
      resolveChannelLimitMb: () => merged.mediaMaxMb,
    }),
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
