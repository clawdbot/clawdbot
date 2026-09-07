// Looks up installed plugin index records by normalized scope.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { compileSafeRegex } from "../security/safe-regex.js";
import { normalizePluginId } from "./config-state.js";
import { CONFIG_PATH_ACTIVATION_COMPAT_CODE } from "./installed-plugin-index-config-path-scope.js";
import { getInstalledPluginIndexFacts } from "./installed-plugin-index-facts.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexScopeLookup,
} from "./installed-plugin-index-types.js";

const PROVIDER_CONTRIBUTION_CONTRACTS = [
  "externalAuthProviders",
  "embeddingProviders",
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

type ModelSupportOwner = {
  pluginId: string;
  prefixes: readonly string[];
  patterns: readonly RegExp[];
};

/** A private ownership index shares normalization and duplicate handling across scope kinds. */
function createOwnerLookup() {
  const owners = new Map<string, Set<string>>();
  const resolve = (id: string) => owners.get(normalizeOptionalLowercaseString(id) ?? "");
  return {
    index(pluginId: string, ids: readonly (string | undefined)[]) {
      for (const id of ids) {
        const key = normalizeOptionalLowercaseString(id);
        if (key) {
          const pluginIds = owners.get(key) ?? new Set<string>();
          pluginIds.add(pluginId);
          owners.set(key, pluginIds);
        }
      }
    },
    add: (target: Set<string>, ids: readonly string[]) => {
      for (const id of ids) {
        for (const pluginId of resolve(id) ?? []) {
          target.add(pluginId);
        }
      }
    },
    has: (ids: readonly string[]) => ids.every((id) => resolve(id) !== undefined),
  };
}

function listValues(value: readonly string[] | undefined): readonly string[] {
  return Array.isArray(value) ? value : [];
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

export function createInstalledPluginIndexScopeLookup(
  index: InstalledPluginIndex,
): InstalledPluginIndexScopeLookup {
  const facts = getInstalledPluginIndexFacts(index);
  if (facts?.scopeLookup) {
    return { ...facts.scopeLookup };
  }
  const agentHarnessOwners = createOwnerLookup();
  const channelContributionOwners = createOwnerLookup();
  const directChannelOwners = createOwnerLookup();
  const installedPluginOwners = createOwnerLookup();
  const providerContributionOwners = createOwnerLookup();
  const pluginIdsByLowercase = new Map<string, string>();
  const modelSupportOwners: ModelSupportOwner[] = [];
  for (const plugin of index.plugins) {
    const normalizedPluginId = normalizeOptionalLowercaseString(plugin.pluginId);
    if (normalizedPluginId) {
      pluginIdsByLowercase.set(normalizedPluginId, plugin.pluginId);
      installedPluginOwners.index(plugin.pluginId, [plugin.pluginId]);
    }
    directChannelOwners.index(plugin.pluginId, [plugin.pluginId, plugin.packageChannel?.id]);
    agentHarnessOwners.index(plugin.pluginId, plugin.startup.agentHarnesses);
    channelContributionOwners.index(plugin.pluginId, [
      plugin.pluginId,
      plugin.packageChannel?.id,
      ...listValues(plugin.contributions?.channels),
      ...listValues(plugin.contributions?.channelConfigs),
    ]);
    providerContributionOwners.index(plugin.pluginId, [
      plugin.pluginId,
      ...listValues(plugin.contributions?.providers),
      ...listValues(plugin.contributions?.modelCatalogProviders),
      ...listValues(plugin.contributions?.autoEnableProviderIds),
      ...PROVIDER_CONTRIBUTION_CONTRACTS.flatMap((contract) =>
        listValues(plugin.contributions?.contracts?.[contract]),
      ),
    ]);
    modelSupportOwners.push({
      pluginId: plugin.pluginId,
      prefixes: listValues(plugin.contributions?.modelSupportPrefixes),
      patterns: listValues(plugin.contributions?.modelSupportPatterns).flatMap((pattern) => {
        const regex = compileSafeRegex(pattern, "u");
        return regex ? [regex] : [];
      }),
    });
  }
  const normalizeInstalledPluginId = (pluginId: string): string => {
    const normalized = normalizePluginId(pluginId);
    const lowercase = normalizeOptionalLowercaseString(normalized);
    return lowercase ? (pluginIdsByLowercase.get(lowercase) ?? normalized) : normalized;
  };
  const lookup: InstalledPluginIndexScopeLookup = {
    addAgentHarnessOwners: agentHarnessOwners.add,
    addChannelContributionOwners: channelContributionOwners.add,
    addDirectChannelOwners: directChannelOwners.add,
    addDirectProviderOwners: installedPluginOwners.add,
    addProviderContributionOwners: providerContributionOwners.add,
    addShorthandModelOwners: (target, modelIds) => {
      for (const modelId of modelIds) {
        for (const owner of modelSupportOwners) {
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
          (installedPluginOwners.has([normalized]) || normalizedScope.has(normalized)),
        );
      });
    },
    hasChannelContributionOwners: channelContributionOwners.has,
    hasAgentHarnessOwners: agentHarnessOwners.has,
    hasCompleteConfigPathActivationMetadata: () =>
      index.plugins.every(
        (plugin) =>
          !plugin.compat.includes(CONFIG_PATH_ACTIVATION_COMPAT_CODE) ||
          plugin.startup.configPaths !== undefined,
      ),
    hasDirectChannelOwners: directChannelOwners.has,
    hasInstalledPluginIds: (ids) => installedPluginOwners.has([...ids]),
    hasProviderContributionOwners: providerContributionOwners.has,
    hasShorthandModelOwners: (modelIds) =>
      modelIds.every((modelId) =>
        modelSupportOwners.some((owner) => modelSupportOwnerMatches(owner, modelId)),
      ),
    normalizePluginId: normalizeInstalledPluginId,
  };
  if (facts) {
    // Callers own their method object; immutable maps remain private to these closures.
    facts.scopeLookup = { ...lookup };
  }
  return lookup;
}
