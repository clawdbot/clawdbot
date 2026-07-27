// Provider/account summary helpers for `openclaw agents list`.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isChannelVisibleInConfiguredLists } from "../channels/plugins/exposure.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AgentBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listExplicitConfiguredChannelIdsForConfig } from "../plugins/channel-plugin-ids.js";
import { resolveMissingOfficialExternalChannelPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
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
  repairHint?: string;
};

function providerAccountKey(provider: ChannelId, accountId?: string) {
  return `${provider}:${accountId ?? DEFAULT_ACCOUNT_ID}`;
}

function resolveProviderChannelId(params: {
  rawChannelId: string | null | undefined;
  metadataByProvider: ReadonlyMap<ChannelId, ProviderSummaryMetadata>;
}): ChannelId | null {
  const resolved = normalizeChannelId(params.rawChannelId);
  if (resolved) {
    return resolved;
  }
  const fallback = normalizeOptionalLowercaseString(params.rawChannelId);
  if (!fallback) {
    return null;
  }
  return params.metadataByProvider.has(fallback as ChannelId) ? (fallback as ChannelId) : null;
}

/** Build stable provider labels/default accounts without resolving live account state. */
export function buildProviderSummaryMetadataIndex(
  cfg: OpenClawConfig,
): Map<ChannelId, ProviderSummaryMetadata> {
  const metadata = new Map<ChannelId, ProviderSummaryMetadata>(
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
  for (const channelId of listExplicitConfiguredChannelIdsForConfig(cfg)) {
    if (metadata.has(channelId)) {
      continue;
    }
    const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
      config: cfg,
      channelId,
    });
    if (!hint) {
      continue;
    }
    metadata.set(channelId as ChannelId, {
      label: hint.label,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      visibleInConfiguredLists: true,
      repairHint: hint.repairHint,
    });
  }
  return metadata;
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

/** Inspect configured provider accounts and classify their display state. */
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

function formatMissingProviderEntry(params: {
  provider: ChannelId;
  accountId: string;
  metadata?: ProviderSummaryMetadata;
}): string {
  const label = formatChannelAccountLabel({
    provider: params.provider,
    providerLabel: params.metadata?.label,
    accountId: params.accountId,
  });
  if (params.metadata?.repairHint) {
    return `${label}: missing plugin - ${params.metadata.repairHint}`;
  }
  return `${label}: unknown`;
}

/** Render the provider/account routes implied by an agent's route bindings. */
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
    const channel = resolveProviderChannelId({
      rawChannelId: binding.match.channel,
      metadataByProvider,
    });
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

/** Render provider status lines relevant to a specific agent summary. */
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
      const channel = resolveProviderChannelId({
        rawChannelId: binding.match.channel,
        metadataByProvider,
      });
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
          formatMissingProviderEntry({
            provider: channel,
            accountId,
            metadata: metadataByProvider.get(channel),
          }),
        );
      }
    }
    return providerLines;
  }

  if (params.summaryIsDefault) {
    const seenProviders = new Set<ChannelId>();
    for (const entry of allProviderEntries) {
      if (shouldShowProviderEntry({ entry, cfg: params.cfg, metadataByProvider })) {
        providerLines.push(formatProviderEntry(entry));
        seenProviders.add(entry.provider);
      }
    }
    for (const [provider, metadata] of metadataByProvider.entries()) {
      if (!metadata.repairHint || seenProviders.has(provider)) {
        continue;
      }
      providerLines.push(
        formatMissingProviderEntry({
          provider,
          accountId: metadata.defaultAccountId,
          metadata,
        }),
      );
    }
  }

  return providerLines;
}
