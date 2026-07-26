// Validates normalized OpenClaw config and reports user-facing errors.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  listAgentEntriesWithSource,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { ChannelDmAllowFromMode } from "../channels/plugins/dm-access.js";
import { planManifestModelCatalogSuppressions } from "../model-catalog/index.js";
import { normalizePluginsConfig, normalizePluginId } from "../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { resolveWebSearchInstallCatalogEntries } from "../plugins/web-search-install-catalog.js";
import { isRecord } from "../utils.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import {
  collectChannelDmPolicyMetadata,
  collectChannelSchemaMetadataWithOwnership,
} from "./channel-config-metadata.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  bundledChannelIds,
  collectChannelDmPolicyDependencyWarnings,
  formatRawChannelConfigIssueMessage,
  hasChannelDmPolicyDependencyWarningCandidates,
  normalizeBundledChannelId,
} from "./validation-channel-rules.js";
import { validateConfigObjectRaw } from "./validation-core.js";
import {
  collectExplicitPluginReferences,
  resolveExplicitPluginReferencePath,
  validateExplicitPluginConfig,
} from "./validation-plugin-config.js";

export { validateConfigObject, validateConfigObjectRaw } from "./validation-core.js";
export { collectUnsupportedSecretRefPolicyIssues } from "./validation-issues.js";

type ValidateConfigWithPluginsResult =
  | { ok: true; config: OpenClawConfig; warnings: ConfigValidationIssue[] }
  | { ok: false; issues: ConfigValidationIssue[]; warnings: ConfigValidationIssue[] };

type ValidateConfigWithPluginsParams = {
  env?: NodeJS.ProcessEnv;
  pluginValidation?: "full" | "skip";
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
  loadPluginMetadataSnapshot?: (
    config: OpenClawConfig,
  ) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  sourceRaw?: unknown;
  preservedLegacyRootKeys?: readonly string[];
};

type RegistryInfo = {
  registry: PluginManifestRegistry;
  knownIds?: Set<string>;
  overriddenPluginIds?: Set<string>;
  normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
  channelDmAllowFromModes?: Map<string, ChannelDmAllowFromMode>;
  channelSchemas?: Map<string, { schema?: Record<string, unknown>; pluginId?: string }>;
};

export function validateConfigObjectWithPlugins(
  raw: unknown,
  params?: ValidateConfigWithPluginsParams,
): ValidateConfigWithPluginsResult {
  const migrated = migratePersistedImplicitMainRoster(raw).config;
  return validateConfigObjectWithPluginsBase(migrated, {
    applyDefaults: true,
    env: params?.env,
    pluginValidation: params?.pluginValidation ?? "full",
    pluginMetadataSnapshot: params?.pluginMetadataSnapshot,
    loadPluginMetadataSnapshot: params?.loadPluginMetadataSnapshot,
    sourceRaw: params?.sourceRaw,
    preservedLegacyRootKeys: params?.preservedLegacyRootKeys,
  });
}

export function validateConfigObjectRawWithPlugins(
  raw: unknown,
  params?: ValidateConfigWithPluginsParams,
): ValidateConfigWithPluginsResult {
  const migrated = migratePersistedImplicitMainRoster(raw).config;
  return validateConfigObjectWithPluginsBase(migrated, {
    applyDefaults: false,
    env: params?.env,
    pluginValidation: params?.pluginValidation ?? "full",
    pluginMetadataSnapshot: params?.pluginMetadataSnapshot,
    loadPluginMetadataSnapshot: params?.loadPluginMetadataSnapshot,
    sourceRaw: params?.sourceRaw,
    preservedLegacyRootKeys: params?.preservedLegacyRootKeys,
  });
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: ValidateConfigWithPluginsParams & { applyDefaults: boolean },
): ValidateConfigWithPluginsResult {
  const base = validateConfigObjectRaw(raw, {
    sourceRaw: opts.sourceRaw,
    preservedLegacyRootKeys: opts.preservedLegacyRootKeys,
    env: opts.env,
  });
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: [] };
  }

  let registryInfo: RegistryInfo | null = opts.pluginMetadataSnapshot
    ? { registry: opts.pluginMetadataSnapshot.manifestRegistry }
    : null;
  if (opts.applyDefaults && !registryInfo) {
    const pluginMetadataSnapshot = opts.loadPluginMetadataSnapshot?.(base.config);
    if (pluginMetadataSnapshot) {
      registryInfo = { registry: pluginMetadataSnapshot.manifestRegistry };
    }
  }
  const config = opts.applyDefaults
    ? materializeRuntimeConfig(base.config, "snapshot", {
        manifestRegistry: registryInfo?.registry,
      })
    : base.config;
  if (opts.pluginValidation === "skip") {
    return { ok: true, config, warnings: [] };
  }

  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  const hasExplicitPluginsConfig = isRecord(raw) && Object.hasOwn(raw, "plugins");
  const explicitPluginReferences = collectExplicitPluginReferences(raw);

  const formatChannelConfigIssueMessage = (message: string, pluginId?: string): string => {
    const safePluginId = pluginId ? sanitizeForLog(pluginId).trim() : "";
    return safePluginId
      ? `invalid config for plugin ${safePluginId}: ${message}`
      : formatRawChannelConfigIssueMessage(message);
  };

  let compatConfig: OpenClawConfig | null | undefined;
  let compatPluginIds: ReadonlySet<string> | null = null;
  let compatPluginIdsResolved = false;
  let registryDiagnosticsPushed = false;

  const pushRegistryDiagnostics = (registry: PluginManifestRegistry): void => {
    if (registryDiagnosticsPushed) {
      return;
    }
    registryDiagnosticsPushed = true;
    for (const diag of registry.diagnostics) {
      const explicitPath = diag.pluginId
        ? resolveExplicitPluginReferencePath(explicitPluginReferences, diag.pluginId)
        : undefined;
      let issuePath = explicitPath ?? "plugins";
      if (!diag.pluginId && diag.message.includes("plugin path not found")) {
        issuePath = "plugins.load.paths";
      }
      const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
      const issue = { path: issuePath, message: `${pluginLabel}: ${diag.message}` };
      if (diag.level === "error" && (explicitPath || !diag.pluginId)) {
        issues.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  };

  const loadValidationRegistry = (): RegistryInfo => {
    const pluginMetadataSnapshot = opts.loadPluginMetadataSnapshot?.(config);
    if (pluginMetadataSnapshot) {
      registryInfo = { registry: pluginMetadataSnapshot.manifestRegistry };
      return registryInfo;
    }
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config), opts.env);
    const registry = resolvePluginMetadataSnapshot({
      config,
      workspaceDir: workspaceDir ?? undefined,
      env: opts.env ?? process.env,
      allowWorkspaceScopedCurrent: true,
    }).manifestRegistry;
    registryInfo = { registry };
    return registryInfo;
  };

  const ensureLoadedRegistryInfo = (): RegistryInfo => registryInfo ?? loadValidationRegistry();

  const ensureCompatPluginIds = (): ReadonlySet<string> => {
    if (compatPluginIdsResolved) {
      return compatPluginIds ?? new Set<string>();
    }
    compatPluginIdsResolved = true;
    const allow = config.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      compatPluginIds = new Set<string>();
      return compatPluginIds;
    }
    const { registry } = registryInfo ?? loadValidationRegistry();
    const overriddenBundledPluginIds = new Set(
      registry.diagnostics
        .filter((diag) => diag.message.includes("duplicate plugin id detected"))
        .map((diag) => diag.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    compatPluginIds = new Set(
      registry.plugins
        .filter(
          (plugin) =>
            plugin.origin === "bundled" &&
            (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
            !overriddenBundledPluginIds.has(plugin.id),
        )
        .map((plugin) => plugin.id),
    );
    return compatPluginIds;
  };

  const ensureCompatConfig = (): OpenClawConfig => {
    if (compatConfig !== undefined) {
      return compatConfig ?? config;
    }
    compatConfig = config;
    return config;
  };

  const ensureRegistry = (): RegistryInfo => {
    const info = ensureLoadedRegistryInfo();
    ensureCompatConfig();
    pushRegistryDiagnostics(info.registry);
    return info;
  };

  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    info.knownIds ??= new Set(info.registry.plugins.map((record) => record.id));
    return info.knownIds;
  };

  const ensureOverriddenPluginIds = (): Set<string> => {
    const info = ensureRegistry();
    info.overriddenPluginIds ??= new Set(
      info.registry.diagnostics
        .filter((diag) => diag.message.includes("duplicate plugin id detected"))
        .map((diag) => diag.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    return info.overriddenPluginIds;
  };

  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    info.normalizedPlugins ??= normalizePluginsConfig(ensureCompatConfig().plugins);
    return info.normalizedPlugins;
  };

  const ensureChannelSchemas = (): Map<
    string,
    { schema?: Record<string, unknown>; pluginId?: string }
  > => {
    const info = ensureRegistry();
    if (!info.channelSchemas) {
      info.channelSchemas = new Map(
        GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(
          (entry) => [entry.channelId, { schema: entry.schema }] as const,
        ),
      );
      for (const entry of collectChannelSchemaMetadataWithOwnership(info.registry)) {
        const current = info.channelSchemas.get(entry.id);
        if (entry.configSchema) {
          info.channelSchemas.set(entry.id, {
            schema: entry.configSchema,
            pluginId: entry.schemaPluginOrigin === "bundled" ? undefined : entry.schemaPluginId,
          });
        } else if (!current) {
          info.channelSchemas.set(entry.id, {});
        }
      }
    }
    return info.channelSchemas;
  };

  const ensureChannelDmAllowFromModes = (): ReadonlyMap<string, ChannelDmAllowFromMode> => {
    const info = ensureLoadedRegistryInfo();
    info.channelDmAllowFromModes ??= new Map(
      collectChannelDmPolicyMetadata(info.registry).flatMap((entry) =>
        entry.dmAllowFromMode ? [[entry.id, entry.dmAllowFromMode] as const] : [],
      ),
    );
    return info.channelDmAllowFromModes;
  };

  // Generic DM-policy/allowFrom dependency check on the raw user config (pre-defaults)
  // so account inheritance matches the per-channel Zod refinements.
  warnings.push(
    ...(hasChannelDmPolicyDependencyWarningCandidates(base.config)
      ? collectChannelDmPolicyDependencyWarnings(base.config, {
          dmAllowFromModes: ensureChannelDmAllowFromModes(),
        })
      : collectChannelDmPolicyDependencyWarnings(base.config)),
  );

  let mutatedConfig = config;
  let channelsCloned = false;
  let pluginsCloned = false;
  let pluginEntriesCloned = false;
  let installedPluginRecordIds: Set<string> | undefined;

  const ensureInstalledPluginRecordIds = (): Set<string> => {
    if (installedPluginRecordIds) {
      return installedPluginRecordIds;
    }
    try {
      installedPluginRecordIds = new Set(
        Object.keys(loadInstalledPluginIndexInstallRecordsSync({ env: opts.env })).map(
          normalizePluginId,
        ),
      );
    } catch {
      installedPluginRecordIds = new Set();
    }
    return installedPluginRecordIds;
  };

  const hasStalePluginEvidenceForUnknownChannel = (channelId: string): boolean => {
    const normalizedChannelId = normalizePluginId(channelId);
    if (!normalizedChannelId || ensureKnownIds().has(normalizedChannelId)) {
      return false;
    }
    const pluginConfig = config.plugins;
    const matches = (pluginId: string) => normalizePluginId(pluginId) === normalizedChannelId;
    return (
      (Array.isArray(pluginConfig?.allow) && pluginConfig.allow.some(matches)) ||
      (isRecord(pluginConfig?.entries) && Object.keys(pluginConfig.entries).some(matches)) ||
      (isRecord(pluginConfig?.installs) && Object.keys(pluginConfig.installs).some(matches)) ||
      ensureInstalledPluginRecordIds().has(normalizedChannelId)
    );
  };

  const collectActiveWebSearchProviderIds = (): string[] => {
    const { registry } = ensureRegistry();
    return [
      ...new Set(
        registry.plugins
          .flatMap((record) => record.contracts?.webSearchProviders ?? [])
          .map((providerId) => providerId.trim())
          .filter((providerId) => providerId.length > 0),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
  };

  const collectKnownWebSearchProviderIds = (): string[] => {
    return [
      ...new Set([
        ...collectActiveWebSearchProviderIds(),
        ...resolveWebSearchInstallCatalogEntries()
          .map((entry) => entry.provider.id.trim())
          .filter((providerId) => providerId.length > 0),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
  };

  const hasPluginEvidenceForWebSearchProvider = (
    ...pluginOrProviderIds: readonly string[]
  ): boolean => {
    const candidateIds = new Set(
      pluginOrProviderIds.map(normalizePluginId).filter((id) => id.length > 0),
    );
    if (candidateIds.size === 0) {
      return false;
    }
    const matches = (pluginId: string) => candidateIds.has(normalizePluginId(pluginId));
    const pluginConfig = config.plugins;
    if (
      (Array.isArray(pluginConfig?.allow) && pluginConfig.allow.some(matches)) ||
      (isRecord(pluginConfig?.entries) && Object.keys(pluginConfig.entries).some(matches)) ||
      (isRecord(pluginConfig?.installs) && Object.keys(pluginConfig.installs).some(matches))
    ) {
      return true;
    }
    return [...candidateIds].some((pluginId) => ensureInstalledPluginRecordIds().has(pluginId));
  };

  const validateWebSearchProvider = (): void => {
    const provider = config.tools?.web?.search?.provider;
    if (typeof provider !== "string") {
      return;
    }
    const trimmed = provider.trim();
    const issuePath = "tools.web.search.provider";
    if (!trimmed) {
      issues.push({ path: issuePath, message: "web_search provider must not be empty" });
      return;
    }
    const activeProviderIds = collectActiveWebSearchProviderIds();
    if (activeProviderIds.includes(trimmed)) {
      return;
    }
    const installCatalogEntry = resolveWebSearchInstallCatalogEntries().find(
      (entry) => entry.provider.id === trimmed,
    );
    if (installCatalogEntry) {
      const issue = {
        path: issuePath,
        message: `web_search provider is not available: ${trimmed} (install or enable plugin "${installCatalogEntry.pluginId}", then run openclaw doctor --fix)`,
        allowedValues: collectKnownWebSearchProviderIds(),
      };
      if (hasPluginEvidenceForWebSearchProvider(trimmed, installCatalogEntry.pluginId)) {
        warnings.push({
          ...issue,
          message: `web_search provider is not available: ${trimmed} (configured plugin "${installCatalogEntry.pluginId}" is unavailable; Gateway will ignore this optional provider until the plugin is installed/enabled or openclaw doctor --fix repairs the config)`,
        });
      } else {
        issues.push(issue);
      }
      return;
    }
    const allowedValues = collectKnownWebSearchProviderIds();
    if (allowedValues.length === 0) {
      return;
    }
    const issue = {
      path: issuePath,
      message: `unknown web_search provider: ${trimmed}`,
      allowedValues,
    };
    const normalizedProviderId = normalizePluginId(trimmed);
    const hasStaleEvidence = Boolean(
      normalizedProviderId &&
      !ensureKnownIds().has(normalizedProviderId) &&
      hasPluginEvidenceForWebSearchProvider(trimmed),
    );
    if (hasStaleEvidence) {
      warnings.push({
        ...issue,
        message: `${issue.message} (stale web search plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
      });
    } else {
      issues.push(issue);
    }
  };

  const validateConfiguredModelRefs = (): void => {
    const configuredRefs = collectConfiguredModelRefs(config);
    if (configuredRefs.length === 0) {
      return;
    }
    const { registry } = ensureRegistry();
    const suppressedModels = new Map<
      string,
      { provider: string; model: string; reason?: string }
    >();
    for (const suppression of planManifestModelCatalogSuppressions({ registry }).suppressions) {
      const key = `${suppression.provider}/${suppression.model}`;
      if (!suppression.when && !suppressedModels.has(key)) {
        suppressedModels.set(key, {
          provider: suppression.provider,
          model: suppression.model,
          ...(suppression.reason ? { reason: suppression.reason } : {}),
        });
      }
    }
    const seen = new Set<string>();
    for (const ref of configuredRefs) {
      const slashIndex = ref.value.indexOf("/");
      if (slashIndex <= 0 || slashIndex >= ref.value.length - 1) {
        continue;
      }
      const provider = normalizeLowercaseStringOrEmpty(ref.value.slice(0, slashIndex));
      const model = normalizeLowercaseStringOrEmpty(ref.value.slice(slashIndex + 1));
      if (!provider || !model) {
        continue;
      }
      const suppression = suppressedModels.get(`${provider}/${model}`);
      const issueKey = `${ref.path}\0${provider}/${model}`;
      if (!suppression || seen.has(issueKey)) {
        continue;
      }
      seen.add(issueKey);
      const modelRef = `${suppression.provider}/${suppression.model}`;
      issues.push({
        path: ref.path,
        message: suppression.reason
          ? `Unknown model: ${modelRef}. ${suppression.reason}`
          : `Unknown model: ${modelRef}.`,
      });
    }
  };

  const replaceChannelConfig = (channelId: string, nextValue: unknown): void => {
    if (!channelsCloned) {
      mutatedConfig = { ...mutatedConfig, channels: { ...mutatedConfig.channels } };
      channelsCloned = true;
    }
    (mutatedConfig.channels as Record<string, unknown>)[channelId] = nextValue;
  };

  const replacePluginEntryConfig = (pluginId: string, nextValue: Record<string, unknown>): void => {
    if (!pluginsCloned) {
      mutatedConfig = { ...mutatedConfig, plugins: { ...mutatedConfig.plugins } };
      pluginsCloned = true;
    }
    if (!pluginEntriesCloned) {
      mutatedConfig.plugins = {
        ...mutatedConfig.plugins,
        entries: { ...mutatedConfig.plugins?.entries },
      };
      pluginEntriesCloned = true;
    }
    const currentEntry = mutatedConfig.plugins?.entries?.[pluginId];
    mutatedConfig.plugins!.entries![pluginId] = { ...currentEntry, config: nextValue };
  };

  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...bundledChannelIds]);
  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        for (const record of ensureRegistry().registry.plugins) {
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        const issue = { path: `channels.${trimmed}`, message: `unknown channel id: ${trimmed}` };
        if (hasStalePluginEvidenceForUnknownChannel(trimmed)) {
          warnings.push({
            ...issue,
            message: `${issue.message} (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
          });
        } else {
          issues.push(issue);
        }
        continue;
      }
      const channelSchema = ensureChannelSchemas().get(trimmed);
      if (!channelSchema?.schema) {
        continue;
      }
      const result = validateJsonSchemaValue({
        schema: channelSchema.schema,
        cacheKey: `channel:${trimmed}`,
        value: config.channels[trimmed],
        applyDefaults: true, // Always apply defaults for AJV schema validation;
        // writeConfigFile persists persistCandidate, not validated.config (#61841)
      });
      if (!result.ok) {
        for (const error of result.errors) {
          issues.push({
            path:
              error.path === "<root>" ? `channels.${trimmed}` : `channels.${trimmed}.${error.path}`,
            message: formatChannelConfigIssueMessage(error.message, channelSchema.pluginId),
            allowedValues: error.allowedValues,
            allowedValuesHiddenCount: error.allowedValuesHiddenCount,
          });
        }
      } else {
        replaceChannelConfig(trimmed, result.value);
      }
    }
  }

  const heartbeatChannelIds = new Set(
    bundledChannelIds.map((channelId) => normalizeLowercaseStringOrEmpty(channelId)),
  );
  const validateHeartbeatTarget = (target: string | undefined, issuePath: string): void => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path: issuePath, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (normalized === "last" || normalized === "none" || normalizeBundledChannelId(trimmed)) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      for (const record of ensureRegistry().registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(normalizeLowercaseStringOrEmpty(pluginChannel));
          }
        }
      }
    }
    if (!heartbeatChannelIds.has(normalized)) {
      issues.push({ path: issuePath, message: `unknown heartbeat target: ${target}` });
    }
  };

  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  for (const { entry, source } of listAgentEntriesWithSource(config)) {
    const pathPrefix =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    validateHeartbeatTarget(entry?.heartbeat?.target, `${pathPrefix}.heartbeat.target`);
  }
  validateWebSearchProvider();
  validateConfiguredModelRefs();

  if (!hasExplicitPluginsConfig) {
    return issues.length > 0
      ? { ok: false, issues, warnings }
      : { ok: true, config: mutatedConfig, warnings };
  }

  const { registry } = ensureRegistry();
  validateExplicitPluginConfig({
    raw,
    config,
    effectiveConfig: ensureCompatConfig(),
    env: opts.env,
    applyDefaults: opts.applyDefaults,
    registry,
    knownIds: ensureKnownIds(),
    normalizedPlugins: ensureNormalizedPlugins(),
    ensureCompatPluginIds,
    ensureOverriddenPluginIds,
    replacePluginEntryConfig,
    issues,
    warnings,
  });

  return issues.length > 0
    ? { ok: false, issues, warnings }
    : { ok: true, config: mutatedConfig, warnings };
}
