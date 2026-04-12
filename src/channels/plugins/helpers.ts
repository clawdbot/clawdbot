import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelSecurityDmPolicy } from "./types.core.js";
import type { ChannelPlugin } from "./types.plugin.js";

// Channel docking helper: use this when selecting the default account for a plugin.
export function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountIds?: string[];
}): string {
  const accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
  return params.plugin.config.defaultAccountId?.(params.cfg) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

export function formatPairingApproveHint(channelId: string): string {
  const listCmd = formatCliCommand(`openclaw pairing list ${channelId}`);
  const approveCmd = formatCliCommand(`openclaw pairing approve ${channelId} <code>`);
  return `Approve via: ${listCmd} / ${approveCmd}`;
}

export function parseOptionalDelimitedEntries(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

export function buildAccountScopedDmSecurityPolicy(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId?: string | null;
  fallbackAccountId?: string | null;
  policy?: string | null;
  allowFrom?: Array<string | number> | null;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
}): ChannelSecurityDmPolicy {
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channelKey
  ] as { accounts?: Record<string, unknown> } | undefined;
  const useAccountPath = Boolean(channelConfig?.accounts?.[resolvedAccountId]);
  const basePath = useAccountPath
    ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.`
    : `channels.${params.channelKey}.`;
  const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
  const policyPath =
    params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : undefined;

  return {
    policy: params.policy ?? params.defaultPolicy ?? "pairing",
    allowFrom: params.allowFrom ?? [],
    policyPath,
    allowFromPath,
    approveHint:
      params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
    normalizeEntry: params.normalizeEntry,
  };
}
