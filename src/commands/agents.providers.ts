import { isChannelVisibleInConfiguredLists } from "../channels/plugins/exposure.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AgentBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type ProviderAccountStatus = {
  provider: ChannelId;
  providerLabel?: string;
  accountId: string;
  name?: string;
  state: "linked" | "not linked" | "configured" | "not configured" | "enabled" | "disabled";
  enabled?: boolean;
  configured?: boolean;
  visibleInConfiguredLists?: boolean;
};

type ProviderSummaryMetadata = {
  label: string;
  defaultAccountId: string;
  visibleInConfiguredLists: boolean;
};

function providerAccountKey(provider: ChannelId, accountId?: string) {
  return `${provider}:${accountId ?? DEFAULT_ACCOUNT_ID}`;
}

export function buildProviderSummaryMetadataIndex(
  cfg: OpenClawConfig,
): Map<ChannelId, ProviderSummaryMetadata> {
  return new Map(
    listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: false,
    }).map((plugin) => [
      plugin.id,
      {
        label: plugin.meta.label,
        defaultAccountId: resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds: plugin.config.listAccountIds(cfg),
        }),
        visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
      },
    ]),
  );
}

function isUnresolvedSecretRefResolutionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    /unresolved SecretRef/i.test(error.message)
  );
}

function formatChannelAccountLabel(params: {
  provider: ChannelId;
  providerLabel?: string;
  accountId: string;
  name?: string;
}): string {
  const label = params.providerLabel ?? params.provider;
  const account = params.name?.trim()
    ? `${params.accountId} (${params.name.trim()})`
    : params.accountId;
  return `${label} ${account}`;
}

function formatProviderState(entry: ProviderAccountStatus): string {
  const parts = [entry.state];
  if (entry.enabled === false && entry.state !== "disabled") {
    parts.push("disabled");
  }
  return parts.join(", ");
}

async function resolveReadOnlyAccount(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<unknown> {
  if (params.plugin.config.inspectAccount) {
    return await Promise.resolve(params.plugin.config.inspectAccount(params.cfg, params.accountId));
  }
  return params.plugin.config.resolveAccount(params.cfg, params.accountId);
}

export async function buildProviderStatusIndex(
  cfg: OpenClawConfig,
): Promise<Map<string, ProviderAccountStatus>> {
  const map = new Map<string, ProviderAccountStatus>();

  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  })) {
    const accountIds = plugin.config.listAccountIds(cfg);
    for (const accountId of accountIds) {
      let account: unknown;
      try {
        account = await resolveReadOnlyAccount({ plugin, cfg, accountId });
      } catch (error) {
        if (!isUnresolvedSecretRefResolutionError(error)) {
          throw error;
        }
        map.set(providerAccountKey(plugin.id, accountId), {
          provider: plugin.id,
          accountId,
          state: "not configured",
          configured: false,
        });
        continue;
      }
      if (!account) {
        continue;
      }
      const snapshot = plugin.config.describeAccount?.(account, cfg);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : typeof snapshot?.enabled === "boolean"
          ? snapshot.enabled
          : (account as { enabled?: boolean }).enabled;
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, cfg)
        : snapshot?.configured;
      const resolvedEnabled = typeof enabled === "boolean" ? enabled : true;
      const resolvedConfigured = typeof configured === "boolean" ? configured : true;
      const state =
        plugin.status?.resolveAccountState?.({
          account,
          cfg,
          configured: resolvedConfigured,
          enabled: resolvedEnabled,
        }) ??
        (typeof snapshot?.linked === "boolean"
          ? snapshot.linked
            ? "linked"
            : "not linked"
          : resolvedConfigured
            ? "configured"
            : "not configured");
      const name = snapshot?.name ?? (account as { name?: string }).name;
      map.set(providerAccountKey(plugin.id, accountId), {
        provider: plugin.id,
        providerLabel: plugin.meta.label,
        accountId,
        name,
        state,
        enabled,
        configured,
        visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
      });
    }
  }

  return map;
}

function resolveDefaultAccountId(
  provider: ChannelId,
  metadataByProvider: ReadonlyMap<ChannelId, ProviderSummaryMetadata>,
): string {
  return metadataByProvider.get(provider)?.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
}

function shouldShowProviderEntry(params: {
  entry: ProviderAccountStatus;
  cfg: OpenClawConfig;
  metadataByProvider: ReadonlyMap<ChannelId, ProviderSummaryMetadata>;
}): boolean {
  const visibleInConfiguredLists =
    params.entry.visibleInConfiguredLists ??
    params.metadataByProvider.get(params.entry.provider)?.visibleInConfiguredLists;
  if (visibleInConfiguredLists === false) {
    const providerConfig = (params.cfg as Record<string, unknown>)[params.entry.provider];
    return Boolean(params.entry.configured) || Boolean(providerConfig);
  }
  return Boolean(params.entry.configured);
}

function formatProviderEntry(entry: ProviderAccountStatus): string {
  const label = formatChannelAccountLabel({
    provider: entry.provider,
    providerLabel: entry.providerLabel,
    accountId: entry.accountId,
    name: entry.name,
  });
  return `${label}: ${formatProviderState(entry)}`;
}

export function summarizeBindings(
  cfg: OpenClawConfig,
  bindings: AgentBinding[],
  metadataByProvider = buildProviderSummaryMetadataIndex(cfg),
): string[] {
  if (bindings.length === 0) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const channel = normalizeChannelId(binding.match.channel);
    if (!channel) {
      continue;
    }
    const accountId =
      binding.match.accountId ?? resolveDefaultAccountId(channel, metadataByProvider);
    const key = providerAccountKey(channel, accountId);
    if (!seen.has(key)) {
      const label = formatChannelAccountLabel({
        provider: channel,
        providerLabel: metadataByProvider.get(channel)?.label,
        accountId,
      });
      seen.set(key, label);
    }
  }
  return [...seen.values()];
}

export function listProvidersForAgent(params: {
  summaryIsDefault: boolean;
  cfg: OpenClawConfig;
  bindings: AgentBinding[];
  providerStatus: Map<string, ProviderAccountStatus>;
  providerMetadata?: ReadonlyMap<ChannelId, ProviderSummaryMetadata>;
}): string[] {
  const allProviderEntries = [...params.providerStatus.values()];
  const providerLines: string[] = [];
  const metadataByProvider =
    params.providerMetadata ?? buildProviderSummaryMetadataIndex(params.cfg);
  if (params.bindings.length > 0) {
    const seen = new Set<string>();
    for (const binding of params.bindings) {
      const channel = normalizeChannelId(binding.match.channel);
      if (!channel) {
        continue;
      }
      const accountId =
        binding.match.accountId ?? resolveDefaultAccountId(channel, metadataByProvider);
      const key = providerAccountKey(channel, accountId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const status = params.providerStatus.get(key);
      if (status) {
        providerLines.push(formatProviderEntry(status));
      } else {
        providerLines.push(
          `${formatChannelAccountLabel({
            provider: channel,
            providerLabel: metadataByProvider.get(channel)?.label,
            accountId,
          })}: unknown`,
        );
      }
    }
    return providerLines;
  }

  if (params.summaryIsDefault) {
    for (const entry of allProviderEntries) {
      if (shouldShowProviderEntry({ entry, cfg: params.cfg, metadataByProvider })) {
        providerLines.push(formatProviderEntry(entry));
      }
    }
  }

  return providerLines;
}
