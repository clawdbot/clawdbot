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
  inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityDmPolicy {
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channelKey
  ] as { accounts?: Record<string, Record<string, unknown>> } | undefined;
  const rootBasePath = `channels.${params.channelKey}.`;
  const accountBasePath = `channels.${params.channelKey}.accounts.${resolvedAccountId}.`;
  const defaultBasePath = `channels.${params.channelKey}.accounts.${DEFAULT_ACCOUNT_ID}.`;
  const accountConfig = channelConfig?.accounts?.[resolvedAccountId];
  const defaultAccountConfig =
    params.inheritSharedDefaultsFromDefaultAccount && resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? channelConfig?.accounts?.[DEFAULT_ACCOUNT_ID]
      : undefined;
  const resolveFieldName = (suffix: string | undefined, fallbackField: string): string | null =>
    suffix == null || suffix === ""
      ? fallbackField
      : /^[A-Za-z0-9_-]+$/.test(suffix)
        ? suffix
        : null;
  const simplePolicyField = resolveFieldName(params.policyPathSuffix, "dmPolicy");
  const simpleAllowFromField = resolveFieldName(params.allowFromPathSuffix, "allowFrom");
  const matchesAnyField = (
    config: Record<string, unknown> | undefined,
    fields: Array<string | null>,
  ) => fields.some((field) => field != null && config?.[field] !== undefined);
  const basePath =
    simplePolicyField || simpleAllowFromField
      ? matchesAnyField(accountConfig, [simplePolicyField, simpleAllowFromField])
        ? accountBasePath
        : matchesAnyField(defaultAccountConfig, [simplePolicyField, simpleAllowFromField])
          ? defaultBasePath
          : matchesAnyField(channelConfig as Record<string, unknown> | undefined, [
                simplePolicyField,
                simpleAllowFromField,
              ])
            ? rootBasePath
            : accountConfig
              ? accountBasePath
              : rootBasePath
      : accountConfig
        ? accountBasePath
        : rootBasePath;
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
