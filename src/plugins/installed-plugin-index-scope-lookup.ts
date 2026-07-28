// Looks up installed plugin index records by normalized scope.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { compileSafeRegex } from "../security/safe-regex.js";
import { normalizePluginId } from "./config-state.js";
import { CONFIG_PATH_ACTIVATION_COMPAT_CODE } from "./installed-plugin-index-config-path-scope.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";

const PROVIDER_CONTRIBUTION_CONTRACTS = [
  "externalAuthProviders",
  "embeddingProviders",
  "memoryEmbeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "meetingNotesSourceProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
] as const;

type OwnerMap = ReadonlyMap<string, readonly string[]>;

type ModelSupportOwner = {
  pluginId: string;
  prefixes: readonly string[];
  patterns: readonly RegExp[];
};

export type InstalledPluginIndexScopeLookup = {
  addChannelContributionOwners: (target: Set<string>, ids: readonly string[]) => void;
  addDirectChannelOwners: (target: Set<string>, ids: readonly string[]) => void;
  addDirectProviderOwners: (target: Set<string>, ids: readonly string[]) => void;
  addProviderContributionOwners: (target: Set<string>, ids: readonly string[]) => void;
  addShorthandModelOwners: (target: Set<string>, modelIds: readonly string[]) => void;
  canResolveDirectProviderIds: (
    providerIds: readonly string[],
    scopePluginIds: ReadonlySet<string>,
  ) => boolean;
  hasChannelContributionOwners: (ids: readonly string[]) => boolean;
  hasCompleteConfigPathActivationMetadata: () => boolean;
  hasDirectChannelOwners: (ids: readonly string[]) => boolean;
  hasInstalledPluginIds: (ids: Iterable<string>) => boolean;
  hasProviderContributionOwners: (ids: readonly string[]) => boolean;
  hasShorthandModelOwners: (modelIds: readonly string[]) => boolean;
  normalizePluginId: (pluginId: string) => string;
};

function appendOwner(
  owners: Map<string, string[]>,
  rawKey: string | undefined,
  pluginId: string,
): void {
  const key = normalizeOptionalLowercaseString(rawKey);
  if (!key) {
    return;
  }
  const existing = owners.get(key);
  if (existing) {
    existing.push(pluginId);
    return;
  }
  owners.set(key, [pluginId]);
}

function freezeOwnerMap(owners: Map<string, string[]>): OwnerMap {
  return new Map(
    [...owners.entries()].map(([key, pluginIds]) => [key, Object.freeze([...new Set(pluginIds)])]),
  );
}

function addOwners(target: Set<string>, owners: OwnerMap, ids: readonly string[]): void {
  for (const id of ids) {
    const normalized = normalizeOptionalLowercaseString(id);
    if (!normalized) {
      continue;
    }
    for (const pluginId of owners.get(normalized) ?? []) {
      target.add(pluginId);
    }
  }
}

function hasOwners(owners: OwnerMap, ids: readonly string[]): boolean {
  return ids.every((id) => {
    const normalized = normalizeOptionalLowercaseString(id);
    return Boolean(normalized && owners.has(normalized));
  });
}

function listContributionValues(
  plugin: InstalledPluginIndexRecord,
  key: keyof NonNullable<InstalledPluginIndexRecord["contributions"]>,
): readonly string[] {
  const value = plugin.contributions?.[key];
  return Array.isArray(value) ? value : [];
}

function listContractContributionValues(
  plugin: InstalledPluginIndexRecord,
  key: string,
): readonly string[] {
  const value = plugin.contributions?.contracts?.[key];
  return Array.isArray(value) ? value : [];
}

function compileModelSupportPatterns(patterns: readonly string[]): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const regex = compileSafeRegex(pattern, "u");
    if (regex) {
      compiled.push(regex);
    }
  }
  return compiled;
}

function modelSupportOwnerMatches(owner: ModelSupportOwner, modelId: string): boolean {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return false;
  }
  if (owner.prefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }
  return owner.patterns.some((pattern) => pattern.test(trimmed));
}

function buildLookupMaps(index: InstalledPluginIndex): {
  channelContributionOwners: OwnerMap;
  directChannelOwners: OwnerMap;
  directProviderOwners: OwnerMap;
  installedPluginIds: ReadonlySet<string>;
  modelSupportOwners: readonly ModelSupportOwner[];
  pluginIdsByLowercase: ReadonlyMap<string, string>;
  providerContributionOwners: OwnerMap;
} {
  const channelContributionOwners = new Map<string, string[]>();
  const directChannelOwners = new Map<string, string[]>();
  const directProviderOwners = new Map<string, string[]>();
  const pluginIdsByLowercase = new Map<string, string>();
  const providerContributionOwners = new Map<string, string[]>();
  const modelSupportOwners: ModelSupportOwner[] = [];

  for (const plugin of index.plugins) {
    const normalizedPluginId = normalizeOptionalLowercaseString(plugin.pluginId);
    if (normalizedPluginId) {
      pluginIdsByLowercase.set(normalizedPluginId, plugin.pluginId);
      appendOwner(directChannelOwners, plugin.pluginId, plugin.pluginId);
      appendOwner(directProviderOwners, plugin.pluginId, plugin.pluginId);
      appendOwner(channelContributionOwners, plugin.pluginId, plugin.pluginId);
      appendOwner(providerContributionOwners, plugin.pluginId, plugin.pluginId);
    }

    appendOwner(directChannelOwners, plugin.packageChannel?.id, plugin.pluginId);
    appendOwner(channelContributionOwners, plugin.packageChannel?.id, plugin.pluginId);
    for (const channelId of listContributionValues(plugin, "channels")) {
      appendOwner(channelContributionOwners, channelId, plugin.pluginId);
    }
    for (const channelId of listContributionValues(plugin, "channelConfigs")) {
      appendOwner(channelContributionOwners, channelId, plugin.pluginId);
    }

    for (const providerId of listContributionValues(plugin, "providers")) {
      appendOwner(providerContributionOwners, providerId, plugin.pluginId);
    }
    for (const providerId of listContributionValues(plugin, "modelCatalogProviders")) {
      appendOwner(providerContributionOwners, providerId, plugin.pluginId);
    }
    for (const providerId of listContributionValues(plugin, "autoEnableProviderIds")) {
      appendOwner(providerContributionOwners, providerId, plugin.pluginId);
    }
    for (const contract of PROVIDER_CONTRIBUTION_CONTRACTS) {
      for (const providerId of listContractContributionValues(plugin, contract)) {
        appendOwner(providerContributionOwners, providerId, plugin.pluginId);
      }
    }

    modelSupportOwners.push({
      pluginId: plugin.pluginId,
      prefixes: listContributionValues(plugin, "modelSupportPrefixes"),
      patterns: compileModelSupportPatterns(listContributionValues(plugin, "modelSupportPatterns")),
    });
  }

  return {
    channelContributionOwners: freezeOwnerMap(channelContributionOwners),
    directChannelOwners: freezeOwnerMap(directChannelOwners),
    directProviderOwners: freezeOwnerMap(directProviderOwners),
    installedPluginIds: new Set(pluginIdsByLowercase.keys()),
    modelSupportOwners,
    pluginIdsByLowercase,
    providerContributionOwners: freezeOwnerMap(providerContributionOwners),
  };
}

export function createInstalledPluginIndexScopeLookup(
  index: InstalledPluginIndex,
): InstalledPluginIndexScopeLookup {
  const maps = buildLookupMaps(index);
  const normalizeInstalledPluginId = (pluginId: string): string => {
    const normalized = normalizePluginId(pluginId);
    const lowercase = normalizeOptionalLowercaseString(normalized);
    return lowercase ? (maps.pluginIdsByLowercase.get(lowercase) ?? normalized) : normalized;
  };
  return {
    addChannelContributionOwners: (target, ids) =>
      addOwners(target, maps.channelContributionOwners, ids),
    addDirectChannelOwners: (target, ids) => addOwners(target, maps.directChannelOwners, ids),
    addDirectProviderOwners: (target, ids) => addOwners(target, maps.directProviderOwners, ids),
    addProviderContributionOwners: (target, ids) =>
      addOwners(target, maps.providerContributionOwners, ids),
    addShorthandModelOwners: (target, modelIds) => {
      for (const modelId of modelIds) {
        for (const owner of maps.modelSupportOwners) {
          if (modelSupportOwnerMatches(owner, modelId)) {
            target.add(owner.pluginId);
          }
        }
      }
    },
    canResolveDirectProviderIds: (providerIds, scopePluginIds) => {
      const normalizedScope = new Set(
        [...scopePluginIds]
          .map((pluginId) => normalizeOptionalLowercaseString(pluginId))
          .filter((pluginId): pluginId is string => Boolean(pluginId)),
      );
      return providerIds.every((providerId) => {
        const normalized = normalizeOptionalLowercaseString(providerId);
        return Boolean(
          normalized &&
          (maps.directProviderOwners.has(normalized) || normalizedScope.has(normalized)),
        );
      });
    },
    hasChannelContributionOwners: (ids) => hasOwners(maps.channelContributionOwners, ids),
    hasCompleteConfigPathActivationMetadata: () =>
      index.plugins.every(
        (plugin) =>
          !plugin.compat.includes(CONFIG_PATH_ACTIVATION_COMPAT_CODE) ||
          plugin.startup.configPaths !== undefined,
      ),
    hasDirectChannelOwners: (ids) => hasOwners(maps.directChannelOwners, ids),
    hasInstalledPluginIds: (ids) =>
      [...ids].every((pluginId) => {
        const normalized = normalizeOptionalLowercaseString(pluginId);
        return Boolean(normalized && maps.installedPluginIds.has(normalized));
      }),
    hasProviderContributionOwners: (ids) => hasOwners(maps.providerContributionOwners, ids),
    hasShorthandModelOwners: (modelIds) =>
      modelIds.every((modelId) =>
        maps.modelSupportOwners.some((owner) => modelSupportOwnerMatches(owner, modelId)),
      ),
    normalizePluginId: normalizeInstalledPluginId,
  };
}
