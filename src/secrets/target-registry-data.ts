/** Builds the static and plugin-derived registry of secret migration targets. */
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";
import { loadChannelSecretContractApiForRecord } from "./channel-contract-api.js";
import { listOfficialExternalChannelSecretTargetRegistryEntries } from "./official-external-channel-secret-contract.js";
import { parseDotPath } from "./shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const SECRET_INPUT_SHAPE = "secret_input"; // pragma: allowlist secret
const SIBLING_REF_SHAPE = "sibling_ref"; // pragma: allowlist secret

const WEB_PROVIDER_SECRET_CONFIGS = [
  { contract: "webSearchProviders", configPath: "webSearch.apiKey" },
  { contract: "webFetchProviders", configPath: "webFetch.apiKey" },
] as const;

type WebProviderSecretConfig = (typeof WEB_PROVIDER_SECRET_CONFIGS)[number];

function createPluginOpenClawConfigSecretTargetEntry(
  pluginId: string,
  configPath: string,
): SecretTargetRegistryEntry {
  const pluginConfigPath = ["plugins", "entries", pluginId, "config"];
  const pathPatternSegments = [...pluginConfigPath, ...parseDotPath(configPath)];
  const pathPattern = `${formatConcreteConfigPath(pluginConfigPath)}.${configPath}`;
  return {
    id: pathPattern,
    targetType: pathPattern,
    configFile: "openclaw.json",
    pathPattern,
    pathPatternSegments,
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };
}

function hasSensitiveConfigHint(
  plugin: PluginManifestRecord,
  configPath: WebProviderSecretConfig["configPath"],
): boolean {
  return plugin.configUiHints?.[configPath]?.sensitive === true;
}

function hasWebProviderContract(
  plugin: PluginManifestRecord,
  contract: WebProviderSecretConfig["contract"],
): boolean {
  return (plugin.contracts?.[contract]?.length ?? 0) > 0;
}

function listPluginWebProviderSecretTargetRegistryEntries(
  plugins: readonly PluginManifestRecord[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  for (const record of plugins) {
    for (const config of WEB_PROVIDER_SECRET_CONFIGS) {
      if (
        hasWebProviderContract(record, config.contract) &&
        hasSensitiveConfigHint(record, config.configPath)
      ) {
        entries.push(createPluginOpenClawConfigSecretTargetEntry(record.id, config.configPath));
      }
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listPluginConfigSecretTargetRegistryEntries(
  plugins: readonly Pick<PluginManifestRecord, "id" | "configContracts">[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const record of plugins) {
    const secretInputs = record.configContracts?.secretInputs?.paths ?? [];
    for (const secretInput of secretInputs) {
      const entry = createPluginOpenClawConfigSecretTargetEntry(record.id, secretInput.path);
      const key = `${entry.configFile}:${entry.pathPattern}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listChannelSecretTargetRegistryEntries(
  channelPlugins: readonly PluginManifestRecord[],
  throwOnLoadError = false,
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];

  for (const record of channelPlugins) {
    try {
      const contractApi = loadChannelSecretContractApiForRecord(record, { throwOnLoadError });
      entries.push(...(contractApi?.secretTargetRegistryEntries ?? []));
    } catch (error) {
      // Runtime can isolate unavailable owners; generated docs must never silently lose targets.
      if (throwOnLoadError) {
        throw error;
      }
    }
  }
  return entries;
}

const CORE_SECRET_TARGET_REGISTRY: SecretTargetRegistryEntry[] = [
  {
    id: "auth-profiles.api_key.key",
    targetType: "auth-profiles.api_key.key",
    configFile: "auth-profile-store",
    pathPattern: "profiles.*.key",
    refPathPattern: "profiles.*.keyRef",
    secretShape: SIBLING_REF_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    authProfileType: "api_key",
  },
  {
    id: "auth-profiles.token.token",
    targetType: "auth-profiles.token.token",
    configFile: "auth-profile-store",
    pathPattern: "profiles.*.token",
    refPathPattern: "profiles.*.tokenRef",
    secretShape: SIBLING_REF_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    authProfileType: "token",
  },
  {
    id: "memory.search.remote.apiKey",
    targetType: "memory.search.remote.apiKey",
    configFile: "openclaw.json",
    pathPattern: "memory.search.remote.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "agents.entries.*.memory.search.remote.apiKey",
    targetType: "agents.entries.*.memory.search.remote.apiKey",
    configFile: "openclaw.json",
    pathPattern: "agents.entries.*.memory.search.remote.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "cron.webhookToken",
    targetType: "cron.webhookToken",
    configFile: "openclaw.json",
    pathPattern: "cron.webhookToken",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.auth.token",
    targetType: "gateway.auth.token",
    configFile: "openclaw.json",
    pathPattern: "gateway.auth.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.auth.password",
    targetType: "gateway.auth.password",
    configFile: "openclaw.json",
    pathPattern: "gateway.auth.password",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.remote.password",
    targetType: "gateway.remote.password",
    configFile: "openclaw.json",
    pathPattern: "gateway.remote.password",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.remote.token",
    targetType: "gateway.remote.token",
    configFile: "openclaw.json",
    pathPattern: "gateway.remote.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "tts.providers.*.apiKey",
    targetType: "tts.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "tts.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "agents.entries.*.tts.providers.*.apiKey",
    targetType: "agents.entries.*.tts.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "agents.entries.*.tts.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: false,
    includeInAudit: true,
    providerIdPathSegmentIndex: 5,
  },
  {
    id: "models.providers.*.apiKey",
    targetType: "models.providers.apiKey",
    targetTypeAliases: ["models.providers.*.apiKey"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
    trackProviderShadowing: true,
  },
  {
    id: "models.providers.*.headers.*",
    targetType: "models.providers.headers",
    targetTypeAliases: ["models.providers.*.headers.*"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.headers.*",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.headers.*",
    targetType: "models.providers.request.headers",
    targetTypeAliases: ["models.providers.*.request.headers.*"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.headers.*",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.auth.token",
    targetType: "models.providers.request.auth.token",
    targetTypeAliases: ["models.providers.*.request.auth.token"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.auth.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.auth.value",
    targetType: "models.providers.request.auth.value",
    targetTypeAliases: ["models.providers.*.request.auth.value"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.auth.value",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.ca",
    targetType: "models.providers.request.proxy.tls.ca",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.ca"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.ca",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.cert",
    targetType: "models.providers.request.proxy.tls.cert",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.cert"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.cert",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.key",
    targetType: "models.providers.request.proxy.tls.key",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.key"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.key",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.passphrase",
    targetType: "models.providers.request.proxy.tls.passphrase",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.passphrase"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.passphrase",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.ca",
    targetType: "models.providers.request.tls.ca",
    targetTypeAliases: ["models.providers.*.request.tls.ca"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.ca",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.cert",
    targetType: "models.providers.request.tls.cert",
    targetTypeAliases: ["models.providers.*.request.tls.cert"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.cert",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.key",
    targetType: "models.providers.request.tls.key",
    targetTypeAliases: ["models.providers.*.request.tls.key"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.key",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.passphrase",
    targetType: "models.providers.request.tls.passphrase",
    targetTypeAliases: ["models.providers.*.request.tls.passphrase"],
    configFile: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.passphrase",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "skills.entries.*.apiKey",
    targetType: "skills.entries.apiKey",
    targetTypeAliases: ["skills.entries.*.apiKey"],
    configFile: "openclaw.json",
    pathPattern: "skills.entries.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "talk.providers.*.apiKey",
    targetType: "talk.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "talk.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "talk.realtime.providers.*.apiKey",
    targetType: "talk.realtime.providers.*.apiKey",
    configFile: "openclaw.json",
    pathPattern: "talk.realtime.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 3,
  },
];

// Derived targets belong to their immutable manifest list, including retained
// runtime scopes; publishing another generation must not reuse their targets.
const secretTargetRegistriesByPlugins = new WeakMap<
  readonly PluginManifestRecord[],
  SecretTargetRegistryEntry[]
>();

/** Builds secret targets from one exact manifest-registry plugin set. */
export function buildSecretTargetRegistryFromPlugins(
  plugins: readonly PluginManifestRecord[],
  options?: { throwOnLoadError?: boolean },
): SecretTargetRegistryEntry[] {
  const cached = secretTargetRegistriesByPlugins.get(plugins);
  // Runtime results may omit broken artifacts; source generation must still validate them.
  if (cached && !options?.throwOnLoadError) {
    return cached;
  }
  const channelPlugins = plugins.filter(
    (record) =>
      record.channels.length > 0 ||
      Object.keys(record.channelConfigs ?? {}).length > 0 ||
      Boolean(record.channelCatalogMeta?.id) ||
      Boolean(record.packageChannel?.id),
  );
  // Installed/workspace plugins own secret targets exactly like bundled ones
  // (#104320: the Exa split moved web providers out of bundled origin and their
  // targets vanished from the gateway's known-target registry). Entries stay
  // manifest-scoped — web-provider contract + sensitive hint, or declared
  // secretInput paths — so a non-bundled origin cannot widen target paths
  // beyond its own declared contracts.
  const entries = [
    ...CORE_SECRET_TARGET_REGISTRY,
    ...listPluginWebProviderSecretTargetRegistryEntries(plugins),
    ...listPluginConfigSecretTargetRegistryEntries(plugins),
    ...listChannelSecretTargetRegistryEntries(channelPlugins, options?.throwOnLoadError),
    ...listOfficialExternalChannelSecretTargetRegistryEntries(),
  ];
  const seen = new Set<string>();
  const registry = entries.filter((entry) => {
    const key = `${entry.configFile}:${entry.pathPattern}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  secretTargetRegistriesByPlugins.set(plugins, registry);
  return registry;
}

/** Returns static core secret target registry entries without plugin-derived targets. */
export function getCoreSecretTargetRegistry(): SecretTargetRegistryEntry[] {
  return CORE_SECRET_TARGET_REGISTRY;
}

/** Returns core plus plugin/channel secret target registry entries for the current metadata view. */
export function getSecretTargetRegistry(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  sourceTree?: boolean;
}): SecretTargetRegistryEntry[] {
  if (params?.sourceTree) {
    // Docs generation needs the source plugin tree, never a process-cached or persisted snapshot.
    const snapshot = resolvePluginMetadataSnapshot({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "extensions",
      },
      preferPersisted: false,
    });
    return buildSecretTargetRegistryFromPlugins(snapshot.plugins, { throwOnLoadError: true });
  }
  const registry = resolveConfigWidePluginManifestRegistry({
    config: params?.config,
    env: params?.env ?? process.env,
  });
  return buildSecretTargetRegistryFromPlugins(registry.plugins);
}
