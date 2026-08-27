// Resolves channel presence policy advertised by plugin metadata.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import {
  hasMeaningfulChannelConfig,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
  type AmbientEnvTriggerPolicy,
  type ChannelPresenceSignalSource,
} from "../channels/config-presence.js";
import { hasChannelPackageState } from "../channels/plugins/package-state-probes.js";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-contributions.js";

/** Source classes that can make a channel appear configured for read-only scopes. */
export type ConfiguredChannelPresenceSource =
  | "explicit-config"
  | Exclude<ChannelPresenceSignalSource, "config">
  | "manifest-env";

/** Reasons a configured channel signal is not effective. */
export type ConfiguredChannelBlockedReason =
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "plugin-disabled"
  | "not-in-allowlist"
  | "workspace-disabled-by-default"
  | "bundled-disabled-by-default"
  | "untrusted-plugin"
  | "no-channel-owner"
  | "not-activated";

/** Policy evaluation row for one configured channel signal. */
export type ConfiguredChannelPresencePolicyEntry = {
  channelId: string;
  sources: ConfiguredChannelPresenceSource[];
  effective: boolean;
  pluginIds: string[];
  blockedReasons: ConfiguredChannelBlockedReason[];
};

const AMBIENT_ENV_SOURCES = new Set<ConfiguredChannelPresenceSource>(["env", "manifest-env"]);

const ANNOUNCE_SUPPRESSING_BLOCKED_REASONS = new Set<ConfiguredChannelBlockedReason>([
  "plugins-disabled",
  "blocked-by-denylist",
  "plugin-disabled",
]);

function normalizeChannelIds(channelIds: Iterable<string>): string[] {
  return sortUniqueStrings(
    [...channelIds].flatMap((channelId) => {
      const normalized = normalizeOptionalLowercaseString(channelId);
      return normalized ? [normalized] : [];
    }),
  );
}

/** True when config contains meaningful enabled channel settings. */
export function hasExplicitChannelConfig(params: {
  config: OpenClawConfig;
  channelId: string;
}): boolean {
  const channels = params.config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  const entry = (channels as Record<string, unknown>)[params.channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const enabled = (entry as { enabled?: unknown }).enabled;
  if (enabled === false) {
    return false;
  }
  return enabled === true || hasMeaningfulChannelConfig(entry);
}

/** Lists explicitly configured channel ids, excluding global channel config keys. */
export function listExplicitConfiguredChannelIdsForConfig(config: OpenClawConfig): string[] {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .flatMap((rawChannelId) => {
      const channelId = rawChannelId.trim();
      return channelId &&
        !isChannelConfigMetadataKey(channelId) &&
        hasExplicitChannelConfig({ config, channelId: rawChannelId })
        ? [channelId]
        : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function recordDeclaresChannel(record: PluginManifestRecord, channelId: string): boolean {
  const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? "";
  if (!normalizedChannelId) {
    return false;
  }
  return record.channels.some(
    (ownedChannelId) =>
      (normalizeOptionalLowercaseString(ownedChannelId) ?? "") === normalizedChannelId,
  );
}

function listManifestEnvConfiguredChannelSignals(params: {
  records: readonly PluginManifestRecord[];
  activationSourceConfig?: OpenClawConfig;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  envSignalChannelIds: ReadonlySet<string>;
}): {
  contractChannelIds: Set<string>;
  signals: Array<{ channelId: string; source: "manifest-env" }>;
} {
  const signals: Array<{ channelId: string; source: "manifest-env" }> = [];
  const contractChannelIds = new Set<string>();
  const seen = new Set<string>();
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  for (const record of params.records) {
    if (
      !isChannelPluginEligibleForScopedOwnership({
        plugin: record,
        normalizedConfig,
        rootConfig: trustConfig,
      })
    ) {
      continue;
    }
    for (const channelId of record.channels) {
      const packageChannel = record.packageChannel;
      const configuredState =
        normalizeOptionalLowercaseString(packageChannel?.id) ===
        normalizeOptionalLowercaseString(channelId)
          ? packageChannel?.configuredState
          : undefined;
      const allOf = configuredState?.env?.allOf ?? [];
      const anyOf = configuredState?.env?.anyOf ?? [];
      const hasModuleContract = Boolean(configuredState?.specifier && configuredState.exportName);
      if (allOf.length === 0 && anyOf.length === 0 && !hasModuleContract) {
        continue;
      }
      const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
      if (!normalizedChannelId) {
        continue;
      }
      contractChannelIds.add(normalizedChannelId);
      if (
        (hasModuleContract && !params.envSignalChannelIds.has(normalizedChannelId)) ||
        !packageChannel ||
        !hasChannelPackageState({
          entry: {
            pluginId: record.id,
            origin: record.origin,
            rootDir: record.rootDir,
            channel: packageChannel,
          },
          metadataKey: "configuredState",
          cfg: params.config,
          env: params.env,
        })
      ) {
        continue;
      }
      if (seen.has(channelId)) {
        continue;
      }
      seen.add(channelId);
      signals.push({ channelId, source: "manifest-env" });
    }
  }
  return {
    contractChannelIds,
    signals: signals.toSorted((left, right) => left.channelId.localeCompare(right.channelId)),
  };
}

function normalizeActivationBlockedReason(reason?: string): ConfiguredChannelBlockedReason {
  switch (reason) {
    case "plugins disabled":
      return "plugins-disabled";
    case "blocked by denylist":
      return "blocked-by-denylist";
    case "disabled in config":
      return "plugin-disabled";
    case "not in allowlist":
      return "not-in-allowlist";
    case "workspace plugin (disabled by default)":
      return "workspace-disabled-by-default";
    case "bundled (disabled by default)":
      return "bundled-disabled-by-default";
    default:
      return "not-activated";
  }
}

function resolveBasePolicyBlockedReason(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  allowRestrictiveAllowlistBypass?: boolean;
}): ConfiguredChannelBlockedReason | null {
  return resolveManifestOwnerBasePolicyBlock(params);
}

function isChannelPluginEligibleForScopedOwnership(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig: OpenClawConfig;
  channelId?: string;
}): boolean {
  // Explicit config can activate bundled channel owners even under restrictive allowlists.
  const allowRestrictiveAllowlistBypass =
    params.channelId !== undefined &&
    isBundledManifestOwner(params.plugin) &&
    hasExplicitChannelConfig({
      config: params.rootConfig,
      channelId: params.channelId,
    });
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
      allowRestrictiveAllowlistBypass,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.plugin)) {
    return true;
  }
  if (params.plugin.origin === "global" || params.plugin.origin === "config") {
    return hasExplicitManifestOwnerTrust({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    });
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

function evaluateEffectiveChannelPlugin(params: {
  plugin: PluginManifestRecord;
  channelId: string;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  config: OpenClawConfig;
  activationSource: ReturnType<typeof createPluginActivationSource>;
}): { effective: boolean; pluginId: string; blockedReason?: ConfiguredChannelBlockedReason } {
  // Bundled channels with explicit config are effective before default enablement checks.
  const explicitBundledChannelConfig =
    isBundledManifestOwner(params.plugin) &&
    hasExplicitChannelConfig({
      config: params.activationSource.rootConfig ?? params.config,
      channelId: params.channelId,
    });
  const baseBlockedReason = resolveBasePolicyBlockedReason({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    allowRestrictiveAllowlistBypass: explicitBundledChannelConfig,
  });
  if (baseBlockedReason) {
    return {
      effective: false,
      pluginId: params.plugin.id,
      blockedReason: baseBlockedReason,
    };
  }

  if (!isBundledManifestOwner(params.plugin)) {
    if (params.plugin.origin === "global" || params.plugin.origin === "config") {
      const trusted = hasExplicitManifestOwnerTrust({
        plugin: params.plugin,
        normalizedConfig: params.normalizedConfig,
      });
      return trusted
        ? { effective: true, pluginId: params.plugin.id }
        : {
            effective: false,
            pluginId: params.plugin.id,
            blockedReason: "untrusted-plugin",
          };
    }
    const activated = isActivatedManifestOwner({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
      rootConfig: params.activationSource.rootConfig,
    });
    return activated
      ? { effective: true, pluginId: params.plugin.id }
      : {
          effective: false,
          pluginId: params.plugin.id,
          blockedReason: "untrusted-plugin",
        };
  }

  if (explicitBundledChannelConfig) {
    return { effective: true, pluginId: params.plugin.id };
  }

  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.id,
    origin: params.plugin.origin,
    config: params.normalizedConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin),
    activationSource: params.activationSource,
  });
  return activationState.enabled
    ? { effective: true, pluginId: params.plugin.id }
    : {
        effective: false,
        pluginId: params.plugin.id,
        blockedReason: normalizeActivationBlockedReason(activationState.reason),
      };
}

function addPolicySignal(
  entries: Map<string, Set<ConfiguredChannelPresenceSource>>,
  channelId: string,
  source: ConfiguredChannelPresenceSource,
) {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return;
  }
  let sources = entries.get(normalized);
  if (!sources) {
    sources = new Set();
    entries.set(normalized, sources);
  }
  sources.add(source);
}

function loadInstalledChannelManifestRecords(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly PluginManifestRecord[] {
  if (!params.workspaceDir) {
    return resolveConfigWidePluginManifestRegistry({
      config: params.config,
      env: params.env,
    }).plugins;
  }
  return loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  }).plugins;
}

/** Resolves effective configured-channel policy rows from config, auth state, env, and manifests. */
export function resolveConfiguredChannelPresencePolicy(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includePersistedAuthState?: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  manifestRecords?: readonly PluginManifestRecord[];
}): ConfiguredChannelPresencePolicyEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir;
  const records =
    params.manifestRecords ??
    loadInstalledChannelManifestRecords({
      config: params.config,
      workspaceDir,
      env,
    });

  const disabledChannelIds = new Set(listExplicitlyDisabledChannelIdsForConfig(params.config));
  const entrySources = new Map<string, Set<ConfiguredChannelPresenceSource>>();
  const potentialSignals = listPotentialConfiguredChannelPresenceSignals(params.config, env, {
    includePersistedAuthState: params.includePersistedAuthState,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const manifestEnv =
    params.ambientEnvTriggers === "suppress"
      ? undefined
      : listManifestEnvConfiguredChannelSignals({
          records,
          config: params.config,
          activationSourceConfig: params.activationSourceConfig,
          env,
          envSignalChannelIds: new Set(
            potentialSignals
              .filter((signal) => signal.source === "env")
              .map((signal) => normalizeOptionalLowercaseString(signal.channelId))
              .filter((channelId): channelId is string => Boolean(channelId)),
          ),
        });
  const configuredManifestEnvChannelIds = new Set(
    manifestEnv?.signals.map((signal) => normalizeOptionalLowercaseString(signal.channelId)),
  );
  for (const channelId of listExplicitConfiguredChannelIdsForConfig(params.config)) {
    addPolicySignal(entrySources, channelId, "explicit-config");
  }
  for (const signal of potentialSignals) {
    const channelId = normalizeOptionalLowercaseString(signal.channelId);
    if (
      signal.source === "config" ||
      (signal.source === "env" &&
        channelId &&
        manifestEnv?.contractChannelIds.has(channelId) &&
        !configuredManifestEnvChannelIds.has(channelId))
    ) {
      continue;
    }
    addPolicySignal(entrySources, signal.channelId, signal.source);
  }
  for (const signal of manifestEnv?.signals ?? []) {
    addPolicySignal(entrySources, signal.channelId, signal.source);
  }
  for (const channelId of disabledChannelIds) {
    entrySources.delete(channelId);
  }
  if (params.ambientEnvTriggers === "suppress") {
    for (const [channelId, sources] of entrySources) {
      if (sources.size > 0 && [...sources].every((source) => AMBIENT_ENV_SOURCES.has(source))) {
        entrySources.delete(channelId);
      }
    }
  }

  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const normalizedConfig = activationSource.plugins;
  const entries: ConfiguredChannelPresencePolicyEntry[] = [];
  for (const channelId of normalizeChannelIds(entrySources.keys())) {
    const owningRecords = records.filter((record) => recordDeclaresChannel(record, channelId));
    const evaluations = owningRecords.map((plugin) =>
      evaluateEffectiveChannelPlugin({
        plugin,
        channelId,
        normalizedConfig,
        config: params.config,
        activationSource,
      }),
    );
    const effectivePluginIds = evaluations
      .filter((entry) => entry.effective)
      .map((entry) => entry.pluginId);
    const blockedReasons =
      owningRecords.length === 0
        ? ["no-channel-owner" as const]
        : [
            ...new Set(
              evaluations
                .map((entry) => entry.blockedReason)
                .filter((reason): reason is ConfiguredChannelBlockedReason => Boolean(reason)),
            ),
          ].toSorted((left, right) => left.localeCompare(right));
    entries.push({
      channelId,
      sources: [...(entrySources.get(channelId) ?? [])].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      effective: effectivePluginIds.length > 0,
      pluginIds: sortUniqueStrings(effectivePluginIds),
      blockedReasons,
    });
  }
  return entries;
}

function listChannelIdsForGatewayPolicy(
  params: Omit<
    Parameters<typeof resolveConfiguredChannelPresencePolicy>[0],
    "includePersistedAuthState"
  >,
  includePersistedAuthState: boolean,
): string[] {
  return resolveConfiguredChannelPresencePolicy({
    ...params,
    includePersistedAuthState,
  })
    .filter(
      (entry) =>
        entry.effective ||
        // A bundled disabled-by-default owner remains eligible even when an
        // untrusted sibling manifest for the same channel is also blocked.
        entry.blockedReasons.includes("bundled-disabled-by-default"),
    )
    .map((entry) => entry.channelId);
}

export function listGatewayActivatedChannelIds(
  params: Omit<
    Parameters<typeof resolveConfiguredChannelPresencePolicy>[0],
    "includePersistedAuthState"
  >,
): string[] {
  // Persisted credentials are migration evidence, not activation consent.
  return listChannelIdsForGatewayPolicy(params, false);
}

export function listChannelIdsForOwnershipMigration(
  params: Omit<
    Parameters<typeof resolveConfiguredChannelPresencePolicy>[0],
    "includePersistedAuthState"
  >,
): string[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir;
  const records =
    params.manifestRecords ??
    loadInstalledChannelManifestRecords({ config: params.config, workspaceDir, env });
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const persistedTrustedChannelIds = listPotentialConfiguredChannelPresenceSignals(
    params.config,
    env,
    {
      includePersistedAuthState: true,
      ambientEnvTriggers: params.ambientEnvTriggers,
    },
  )
    .filter((signal) => signal.source === "persisted-auth")
    .map((signal) => signal.channelId)
    .filter((channelId) =>
      records.some(
        (plugin) =>
          recordDeclaresChannel(plugin, channelId) &&
          isChannelPluginEligibleForScopedOwnership({
            plugin,
            normalizedConfig,
            rootConfig: trustConfig,
          }),
      ),
    );
  // Migration preserves trusted persisted state even when activation is disabled.
  return normalizeChannelIds([
    ...listChannelIdsForGatewayPolicy(params, true),
    ...persistedTrustedChannelIds,
  ]);
}

/** Lists channels that suppression removes because their only presence is ambient env. */
export function listAmbientOnlyConfiguredChannelIds(
  params: Omit<Parameters<typeof resolveConfiguredChannelPresencePolicy>[0], "ambientEnvTriggers">,
): string[] {
  return resolveConfiguredChannelPresencePolicy({
    ...params,
    ambientEnvTriggers: "allow",
  })
    .filter(
      (entry) =>
        entry.sources.length > 0 &&
        entry.sources.every((source) => AMBIENT_ENV_SOURCES.has(source)),
    )
    .map((entry) => entry.channelId);
}

/** Lists effective channel ids available to read-only scoped discovery. */
export function listConfiguredChannelIdsForReadOnlyScope(
  params: Parameters<typeof resolveConfiguredChannelPresencePolicy>[0],
): string[] {
  return resolveConfiguredChannelPresencePolicy(params)
    .filter((entry) => entry.effective)
    .map((entry) => entry.channelId);
}

/** True when read-only scoped discovery has any effective configured channel. */
export function hasConfiguredChannelsForReadOnlyScope(
  params: Parameters<typeof resolveConfiguredChannelPresencePolicy>[0],
): boolean {
  return listConfiguredChannelIdsForReadOnlyScope(params).length > 0;
}

/** Lists channel ids that should be announced as configured for operators. */
export function listConfiguredAnnounceChannelIdsForConfig(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  const disabledChannelIds = new Set(listExplicitlyDisabledChannelIdsForConfig(params.config));
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const policy = resolveConfiguredChannelPresencePolicy({
    config: params.config,
    activationSourceConfig: trustConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includePersistedAuthState: false,
    manifestRecords: params.manifestRecords,
  });
  const policyDisabledChannelIds = new Set(
    policy
      .filter(
        (entry) =>
          !entry.effective &&
          entry.blockedReasons.some((reason) => ANNOUNCE_SUPPRESSING_BLOCKED_REASONS.has(reason)),
      )
      .map((entry) => entry.channelId),
  );
  const explicitChannelIds = listExplicitConfiguredChannelIdsForConfig(params.config).filter(
    (channelId) =>
      normalizedConfig.enabled &&
      !normalizedConfig.deny.includes(channelId) &&
      normalizedConfig.entries[channelId]?.enabled !== false &&
      (normalizedConfig.allow.length === 0 || normalizedConfig.allow.includes(channelId)),
  );
  return normalizeChannelIds([
    ...explicitChannelIds,
    ...policy.filter((entry) => entry.effective).map((entry) => entry.channelId),
  ]).filter(
    (channelId) => !disabledChannelIds.has(channelId) && !policyDisabledChannelIds.has(channelId),
  );
}

function resolveScopedChannelOwnerPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  const channelIds = normalizeChannelIds(params.channelIds);
  if (channelIds.length === 0) {
    return [];
  }
  const records =
    params.manifestRecords ??
    loadInstalledChannelManifestRecords({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const candidateIds = sortUniqueStrings(
    channelIds.flatMap((channelId) => {
      return resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: channelId,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        manifestRecords: records,
        allowRestrictiveAllowlistBypass: hasExplicitChannelConfig({
          config: trustConfig,
          channelId,
        }),
      });
    }),
  );
  if (candidateIds.length === 0) {
    return [];
  }
  const candidateIdSet = new Set(candidateIds);
  return records
    .filter((plugin) => {
      if (!candidateIdSet.has(plugin.id)) {
        return false;
      }
      return isChannelPluginEligibleForScopedOwnership({
        plugin,
        normalizedConfig,
        rootConfig: trustConfig,
        channelId: channelIds.find((channelId) => recordDeclaresChannel(plugin, channelId)),
      });
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

/** Resolves plugin ids discoverable for scoped channel activation. */
export function resolveDiscoverableScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

/** Resolves plugin ids that own currently configured channels. */
export function resolveConfiguredChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  const configuredChannelIds = normalizeChannelIds([
    ...listConfiguredChannelIdsForReadOnlyScope({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRecords: params.manifestRecords,
    }),
    ...listExplicitConfiguredChannelIdsForConfig(params.activationSourceConfig ?? params.config),
  ]);
  if (configuredChannelIds.length === 0) {
    return [];
  }
  return resolveScopedChannelOwnerPluginIds({
    ...params,
    channelIds: configuredChannelIds,
  });
}
