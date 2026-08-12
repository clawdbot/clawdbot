// Validates normalized OpenClaw config and reports user-facing errors.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
import type { ChannelDmAllowFromMode } from "../channels/plugins/dm-access.js";
import { planManifestModelCatalogSuppressions } from "../model-catalog/index.js";
import { listChannelIdsForOwnershipMigration } from "../plugins/channel-presence-policy.js";
import { normalizePluginsConfig, normalizePluginId } from "../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveActiveRuntimeChannelOwners } from "../plugins/runtime-channel-owners.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { resolveWebSearchInstallCatalogEntries } from "../plugins/web-search-install-catalog.js";
import { isRecord } from "../utils.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { normalizeManifestChannelId } from "./channel-claimant-plugins.js";
import {
  collectChannelDmPolicyMetadata,
  collectChannelSchemaMetadataWithOwnership,
} from "./channel-config-metadata.js";
import { resolveChannelConfigKey } from "./channel-configured-shared.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { migrateLegacyContextBudgetConfig } from "./legacy.context-budget.js";
import {
  inheritLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import {
  getRuntimeAmbientEnvTriggers,
  getRuntimeConfigSourceSnapshot,
  hashRuntimeConfigValue,
} from "./runtime-snapshot.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { settleDefaultedChannelSchemas } from "./validation-channel-defaults.js";
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
  pluginValidation?: "full" | "skip" | "core-only";
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
  return validateConfigObjectWithPluginMode(raw, params, true);
}

export function validateConfigObjectRawWithPlugins(
  raw: unknown,
  params?: ValidateConfigWithPluginsParams,
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginMode(raw, params, false);
}

function validateConfigObjectWithPluginMode(
  raw: unknown,
  params: ValidateConfigWithPluginsParams | undefined,
  applyDefaults: boolean,
): ValidateConfigWithPluginsResult {
  const contextBudgetConfig = migrateLegacyContextBudgetConfig(raw).config;
  const migrated = migratePersistedImplicitMainRoster(contextBudgetConfig).config as OpenClawConfig;
  let manifestRegistry = params?.pluginMetadataSnapshot?.manifestRegistry;
  const result = validateConfigObjectWithPluginsBase(migrated, {
    applyDefaults,
    env: params?.env,
    pluginValidation: params?.pluginValidation ?? "full",
    pluginMetadataSnapshot: params?.pluginMetadataSnapshot,
    loadPluginMetadataSnapshot: params?.loadPluginMetadataSnapshot,
    sourceRaw: params?.sourceRaw,
    preservedLegacyRootKeys: params?.preservedLegacyRootKeys,
    onManifestRegistryResolved: (registry) => {
      manifestRegistry = registry;
    },
  });
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(migrated);
  if (!result.ok || !legacyDefaultAgentId) {
    return result;
  }
  // Carry the migration sidecar across Zod's fresh object.
  const validatedConfig = inheritLegacyDefaultAgentId(migrated, result.config);
  const materialized = materializeLegacyAgentOwnershipForActiveChannelsResult(
    validatedConfig,
    legacyDefaultAgentId,
    params?.env,
    manifestRegistry?.plugins,
  );
  const config = materialized.config;
  return { ...result, config };
}

export function materializeLegacyAgentOwnershipForActiveChannelsResult(
  config: OpenClawConfig,
  legacyDefaultAgentId: string,
  env?: NodeJS.ProcessEnv,
  manifestRecords?: PluginManifestRegistry["plugins"],
  options?: { materializeSessionStore?: boolean; materializeWorkspace?: boolean },
): ReturnType<typeof materializeLegacyDefaultAgentRoles> {
  const ambientChannelIds = listChannelIdsForOwnershipMigration({
    config,
    env,
    ...(manifestRecords ? { manifestRecords } : {}),
  });
  const materialized = materializeLegacyDefaultAgentRoles(config, legacyDefaultAgentId, {
    ambientChannelIds,
    env,
    materializeSessionStore: options?.materializeSessionStore,
    materializeWorkspace: options?.materializeWorkspace,
  });
  const next = inheritLegacyDefaultAgentId(config, materialized.config);
  return { ...materialized, config: next };
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: ValidateConfigWithPluginsParams & {
    applyDefaults: boolean;
    onManifestRegistryResolved?: (registry: PluginManifestRegistry) => void;
  },
): ValidateConfigWithPluginsResult {
  const base = validateConfigObjectRaw(raw, {
    sourceRaw: opts.sourceRaw,
    preservedLegacyRootKeys: opts.preservedLegacyRootKeys,
    env: opts.env,
  });
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: [] };
  }
  // Zod returns a fresh object. Preserve the migration-only owner before
  // workspace-scoped plugin discovery, or legacy-root plugins disappear here.
  const parsedConfig = inheritLegacyDefaultAgentId(raw as OpenClawConfig, base.config);

  const rememberRegistry = (registry: PluginManifestRegistry): RegistryInfo => {
    opts.onManifestRegistryResolved?.(registry);
    return { registry };
  };
  let registryInfo: RegistryInfo | null = opts.pluginMetadataSnapshot
    ? rememberRegistry(opts.pluginMetadataSnapshot.manifestRegistry)
    : null;
  if (opts.applyDefaults && !registryInfo && opts.pluginValidation !== "core-only") {
    const pluginMetadataSnapshot = opts.loadPluginMetadataSnapshot?.(parsedConfig);
    if (pluginMetadataSnapshot) {
      registryInfo = rememberRegistry(pluginMetadataSnapshot.manifestRegistry);
    }
  }
  const config = opts.applyDefaults
    ? materializeRuntimeConfig(parsedConfig, "snapshot", {
        manifestRegistry:
          registryInfo?.registry ??
          (opts.pluginValidation === "core-only" ? { plugins: [] } : undefined),
      })
    : parsedConfig;
  if (opts.pluginValidation === "skip" || opts.pluginValidation === "core-only") {
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
      registryInfo = rememberRegistry(pluginMetadataSnapshot.manifestRegistry);
      return registryInfo;
    }
    const registry = resolveConfigWidePluginManifestRegistry({
      config,
      env: opts.env ?? process.env,
    });
    registryInfo = rememberRegistry(registry);
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

  const activationSurfaceHash = (cfg: OpenClawConfig): string =>
    hashRuntimeConfigValue({
      channels: cfg.channels,
      plugins: cfg.plugins,
      auth: cfg.auth,
      tools: cfg.tools,
      models: cfg.models,
      // Config-owned env vars are activation surface: gateway reload applies the candidate's
      // env, where an env-only channel can change a cross-channel replacement plan — the
      // candidate fingerprint below runs against the CURRENT process env and cannot see them.
      env: cfg.env,
    } as OpenClawConfig);
  const validatesActiveRegistryConfig = (): boolean => {
    const sourceSnapshot = getRuntimeConfigSourceSnapshot();
    if (!sourceSnapshot || !isRecord(raw)) {
      return false;
    }
    const rawConfig = raw as OpenClawConfig;
    if (activationSurfaceHash(rawConfig) !== activationSurfaceHash(sourceSnapshot)) {
      return false;
    }
    // Capability candidates arise from sections OUTSIDE the hashed surface too (tts,
    // cloudWorkers, agent-harness settings, …): compare the probe-less candidate list the
    // claimant resolver actually consumes, so any config section that changes claimant planning
    // sends the prospective config to its own plan instead of the landed owners.
    const ambientEnvTriggers = getRuntimeAmbientEnvTriggers();
    const candidateFingerprint = (cfg: OpenClawConfig): string =>
      JSON.stringify(
        detectPluginAutoEnableCandidates({
          config: cfg,
          env: opts.env,
          manifestRegistry: ensureRegistry().registry,
          setupProbes: "skip",
          ...(ambientEnvTriggers ? { ambientEnvTriggers } : {}),
        }),
      );
    return candidateFingerprint(rawConfig) === candidateFingerprint(sourceSnapshot);
  };

  const buildChannelSchemas = (
    planConfig: OpenClawConfig,
  ): Map<string, { schema?: Record<string, unknown>; pluginId?: string }> => {
    const info = ensureRegistry();
    const schemas = new Map<string, { schema?: Record<string, unknown>; pluginId?: string }>(
      GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(
        (entry) => [entry.channelId, { schema: entry.schema }] as const,
      ),
    );
    const ambientEnvTriggers = getRuntimeAmbientEnvTriggers();
    // Landed channel registrations outrank prediction ONLY for the config that produced the
    // active registry: a prospective mutation (config.set/patch selecting a replacement) must
    // validate against ITS OWN auto-enable plan, or the old runtime owner's schema vetoes the
    // very change that replaces it. The gate is activation-surface equality between the raw
    // candidate and the published authored source — edits outside that surface keep landed
    // ownership for the running system; outside a gateway process both facts are absent and
    // the projection stays predictive.
    const runtimeChannelOwners = validatesActiveRegistryConfig()
      ? resolveActiveRuntimeChannelOwners()
      : undefined;
    for (const entry of collectChannelSchemaMetadataWithOwnership(
      info.registry,
      planConfig,
      opts.env,
      {
        // Ownership planning honors the gateway's ambient env-trigger policy, so an env-only
        // channel startup excludes cannot decide claimant fates validation ranks schemas by.
        ...(ambientEnvTriggers ? { ambientEnvTriggers } : {}),
        ...(runtimeChannelOwners ? { runtimeChannelOwners } : {}),
      },
    )) {
      const current = schemas.get(entry.id);
      if (entry.configSchema) {
        schemas.set(entry.id, {
          schema: entry.configSchema,
          pluginId: entry.schemaPluginOrigin === "bundled" ? undefined : entry.schemaPluginId,
        });
      } else if (!current) {
        schemas.set(entry.id, {});
      }
    }
    return schemas;
  };

  // False only when default hydration oscillated: the settled schemas are the AUTHORED
  // record's, and the returned config must STAY on the authored record — applying the settled
  // owners' defaults would hand the gateway the very hydrated record whose plan contradicts
  // them (see `settleDefaultedChannelSchemas`).
  let channelDefaultsConverged = true;
  const ensureChannelSchemas = (): Map<
    string,
    { schema?: Record<string, unknown>; pluginId?: string }
  > => {
    const info = ensureRegistry();
    if (!info.channelSchemas) {
      const planBaseConfig = ensureCompatConfig();
      let schemas = buildChannelSchemas(planBaseConfig);
      // Gateway auto-enable consumes the DEFAULTED config: settle default hydration and
      // ownership planning to a fixpoint (or deterministically on the authored record when
      // hydration oscillates) — see `settleDefaultedChannelSchemas`.
      const channelsRecord = isRecord(config.channels) ? config.channels : undefined;
      if (channelsRecord) {
        const compatChannels = isRecord(planBaseConfig.channels) ? planBaseConfig.channels : {};
        const settled = settleDefaultedChannelSchemas({
          channelsRecord,
          compatChannels,
          initialSchemas: schemas,
          buildSchemas: (channels) =>
            buildChannelSchemas({ ...planBaseConfig, channels } as OpenClawConfig),
        });
        schemas = settled.schemas;
        if (!settled.converged) {
          channelDefaultsConverged = false;
          warnings.push({
            path: "channels",
            message:
              "channel schema ownership does not converge under schema defaults; validating and returning the authored channel config without applying defaults",
          });
        }
      }
      info.channelSchemas = schemas;
    }
    return info.channelSchemas;
  };

  const ensureChannelDmAllowFromModes = (): ReadonlyMap<string, ChannelDmAllowFromMode> => {
    const info = ensureLoadedRegistryInfo();
    // The collector keys by canonical channel identity (origin precedence applies across
    // alias-equivalent claimants there); the warning path canonicalizes its lookup to match.
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
    ...(hasChannelDmPolicyDependencyWarningCandidates(parsedConfig)
      ? collectChannelDmPolicyDependencyWarnings(parsedConfig, {
          dmAllowFromModes: ensureChannelDmAllowFromModes(),
        })
      : collectChannelDmPolicyDependencyWarnings(parsedConfig)),
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
  // First record-shaped section per canonical channel identity, by authored key. Admission folds
  // variant spellings onto one channel while `resolveChannelConfigKey` serves exactly one section
  // per identity, so a second record folding onto a seen identity must reject: validating it
  // would accept credentials or `enabled: false` that activation silently ignores.
  const channelSectionKeyByCanonicalId = new Map<string, string>();
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
            // A variant manifest spelling (built-in alias, case variant) admits the canonical
            // key too — the runtime normalizes both onto one channel identity.
            allowedChannels.add(normalizeManifestChannelId(channelId));
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
      // Only record-shaped sections can shadow each other: the resolver never serves a
      // non-record entry as a channel's config record.
      if (isRecord(config.channels[trimmed])) {
        const canonicalChannelId = normalizeManifestChannelId(trimmed);
        const firstSectionKey = channelSectionKeyByCanonicalId.get(canonicalChannelId);
        if (firstSectionKey !== undefined) {
          // The winning key comes from the activation resolver itself, so the message states
          // exactly which section the runtime reads (exact canonical key first, else the first
          // authored record that folds). The named repair is the doctor merge migration
          // (channels.duplicate-alias-sections-merge), which keeps that same winner.
          const servedKey = resolveChannelConfigKey(config, canonicalChannelId);
          issues.push({
            path: `channels.${trimmed}`,
            message: `duplicate channel config: "${firstSectionKey}" and "${trimmed}" both configure channel "${canonicalChannelId}" and activation reads only channels.${servedKey}; run openclaw doctor --fix to merge these sections`,
          });
          continue;
        }
        channelSectionKeyByCanonicalId.set(canonicalChannelId, trimmed);
      }
      // Schema metadata is keyed by canonical channel identity; the authored key may be a
      // declared variant spelling. Issue paths and the cache key keep the authored spelling.
      const channelSchema = ensureChannelSchemas().get(normalizeManifestChannelId(trimmed));
      if (!channelSchema?.schema) {
        continue;
      }
      const result = validateJsonSchemaValue({
        schema: channelSchema.schema,
        cacheKey: `channel:${trimmed}`,
        value: config.channels[trimmed],
        // Apply defaults for AJV schema validation (writeConfigFile persists persistCandidate,
        // not validated.config — #61841) UNLESS ownership settlement did not converge: the
        // settled schemas are the authored record's, and hydrating the returned config would
        // hand the gateway the contradicting record the settlement rejected.
        applyDefaults: channelDefaultsConverged,
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
      } else if (channelDefaultsConverged) {
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
    if (
      normalized === "owner" ||
      normalized === "last" ||
      normalized === "none" ||
      normalizeBundledChannelId(trimmed)
    ) {
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
