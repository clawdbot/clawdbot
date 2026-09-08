import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listRawChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveConfiguredChannelPresencePolicy } from "../../../plugins/channel-plugin-ids.js";
import { collectConfiguredMemoryEmbeddingProviderIds } from "../../../plugins/gateway-startup-plugin-ids.js";
import { collectConfiguredSpeechProviderIds } from "../../../plugins/gateway-startup-speech-providers.js";
import { isNativeSessionCatalogOptOutOnly } from "../../../plugins/native-session-catalog-config.js";
import {
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
} from "../../../plugins/official-external-plugin-catalog.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveWebSearchInstallCatalogEntriesForEnv,
  resolveWebSearchInstallCatalogEntry,
} from "../../../plugins/web-search-install-catalog.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { collectConfiguredProviderPluginIds } from "./configured-provider-plugin-installs.js";
import { collectConfiguredRuntimePluginIds } from "./configured-runtime-plugin-installs.js";

function addConfiguredPluginId(ids: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const pluginId = value.trim();
  if (pluginId) {
    ids.add(pluginId);
  }
}

function addConfiguredAgentRuntimePluginIds(ids: Set<string>, cfg: OpenClawConfig): void {
  for (const runtime of collectConfiguredRuntimePluginIds(cfg)) {
    addConfiguredPluginId(ids, runtime);
  }
}

function addConfiguredMemoryEmbeddingProviderPluginIds(
  ids: Set<string>,
  cfg: OpenClawConfig,
): void {
  const configuredProviderIds = collectConfiguredMemoryEmbeddingProviderIds(cfg);
  if (configuredProviderIds.size === 0) {
    return;
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "embeddingProviders",
    providerIds: configuredProviderIds,
  })) {
    ids.add(pluginId);
  }
}

function addConfiguredSpeechProviderPluginIds(ids: Set<string>, cfg: OpenClawConfig): void {
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "speechProviders",
    providerIds: collectConfiguredSpeechProviderIds(cfg),
  })) {
    ids.add(pluginId);
  }
}

function addConfiguredWebFetchProviderPluginIds(ids: Set<string>, cfg: OpenClawConfig): void {
  const webFetch = cfg.tools?.web?.fetch;
  if (webFetch?.enabled === false) {
    return;
  }
  const providerId = normalizeOptionalLowercaseString(webFetch?.provider);
  if (!providerId) {
    return;
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "webFetchProviders",
    providerIds: new Set([providerId]),
  })) {
    ids.add(pluginId);
  }
}

function addEnvWebFetchProviderPluginIds(
  ids: Set<string>,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): void {
  if (cfg.tools?.web?.fetch?.enabled === false) {
    return;
  }
  for (const pluginId of resolveOfficialExternalWebProviderContractPluginIdsForEnv({
    contract: "webFetchProviders",
    env: env ?? process.env,
  })) {
    ids.add(pluginId);
  }
}

export function collectConfiguredPluginIds(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  const ids = new Set<string>();
  const plugins = asNullableRecord(cfg.plugins);
  if (plugins?.enabled === false) {
    return ids;
  }
  const entries = asNullableRecord(plugins?.entries);
  for (const [pluginId, entry] of Object.entries(entries ?? {})) {
    if (
      asNullableRecord(entry)?.enabled === false ||
      isNativeSessionCatalogOptOutOnly(pluginId, entry)
    ) {
      continue;
    }
    addConfiguredPluginId(ids, pluginId);
  }
  const searchProvider = cfg.tools?.web?.search?.provider;
  if (cfg.tools?.web?.search?.enabled !== false && typeof searchProvider === "string") {
    const installEntry = resolveWebSearchInstallCatalogEntry({ providerId: searchProvider });
    if (installEntry?.pluginId) {
      ids.add(installEntry.pluginId);
    }
  }
  if (cfg.tools?.web?.search?.enabled !== false) {
    // Env-only web providers are valid auto-detect inputs and need their manifest installed first.
    for (const entry of resolveWebSearchInstallCatalogEntriesForEnv(env ?? process.env)) {
      ids.add(entry.pluginId);
    }
  }
  addConfiguredAgentRuntimePluginIds(ids, cfg);
  for (const pluginId of collectConfiguredProviderPluginIds({ cfg, env })) {
    ids.add(pluginId);
  }
  addConfiguredMemoryEmbeddingProviderPluginIds(ids, cfg);
  addConfiguredSpeechProviderPluginIds(ids, cfg);
  addConfiguredWebFetchProviderPluginIds(ids, cfg);
  addEnvWebFetchProviderPluginIds(ids, cfg, env);
  return ids;
}

export function collectBlockedPluginIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const deny = cfg.plugins?.deny;
  if (Array.isArray(deny)) {
    for (const pluginId of deny) {
      if (typeof pluginId === "string" && pluginId.trim()) {
        ids.add(pluginId.trim());
      }
    }
  }
  const entries = asNullableRecord(cfg.plugins?.entries);
  for (const [pluginId, entry] of Object.entries(entries ?? {})) {
    if (pluginId.trim() && asNullableRecord(entry)?.enabled === false) {
      ids.add(pluginId.trim());
    }
  }
  return ids;
}

export function collectConfiguredChannelIds(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  if (asNullableRecord(cfg.plugins)?.enabled === false) {
    return new Set();
  }
  const candidateChannelIds = listRawChannelPluginCatalogEntries({
    env,
    excludeWorkspace: true,
  }).map((entry) => entry.id);
  return new Set(
    listDoctorConfiguredChannelIds(cfg, {
      configEntryPolicy: "meaningful",
      env: env ?? process.env,
      candidateChannelIds,
      skipWhenPluginsDisabled: true,
      excludeExplicitlyDisabled: true,
    }),
  );
}

export function collectEffectiveConfiguredChannelOwnerPluginIds(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  snapshot: PluginMetadataSnapshot;
  configuredChannelIds: ReadonlySet<string>;
}): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  const configuredChannelIds = new Set(
    [...params.configuredChannelIds]
      .map((channelId) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  if (configuredChannelIds.size === 0) {
    return owners;
  }
  for (const entry of resolveConfiguredChannelPresencePolicy({
    config: params.cfg,
    env: params.env,
    includePersistedAuthState: false,
    manifestRecords: params.snapshot.plugins,
  })) {
    if (!entry.effective || !configuredChannelIds.has(entry.channelId)) {
      continue;
    }
    const pluginIds = new Set(entry.pluginIds);
    if (pluginIds.size > 0) {
      owners.set(entry.channelId, pluginIds);
    }
  }
  return owners;
}
