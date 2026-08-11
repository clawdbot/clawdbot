// Shares plugin auto-enable detection across config and runtime code.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import {
  listPotentialConfiguredChannelPresenceSignals,
  type AmbientEnvTriggerPolicy,
  type ChannelPresenceSignalSource,
} from "../channels/config-presence.js";
import {
  hasBundledChannelConfiguredState,
  listBundledChannelIdsWithConfiguredState,
} from "../channels/plugins/configured-state.js";
import { findChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { hasMaterialPluginEntryConfig, normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { collectConfiguredSpeechProviderIds } from "../plugins/gateway-startup-speech-providers.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isOfficialExternalPluginId } from "../plugins/official-external-plugin-catalog.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  declaresPluginPreferenceOver,
  normalizePluginPolicyId,
} from "../plugins/plugin-policy-id.js";
import { resolveOwningPluginIdsForModelRef } from "../plugins/providers.js";
import { resolvePluginSetupAutoEnableReasons } from "../plugins/setup-registry.js";
import { collectConfiguredWorkerProviderIds } from "../plugins/worker-provider-config.js";
import { listBundledWorkerProviderOwners } from "../plugins/worker-provider-manifest.js";
import {
  collectPluginIdsForConfiguredChannel,
  resolvePluginKeyThroughRegistryAliases,
  collectPluginSelectionPolicyIds,
  createChannelClaimantResolution,
  isPluginPolicyDenied,
  isPluginPolicyDisabled,
  isPluginSelectedWithAliases,
  normalizeManifestChannelId,
  normalizePluginsConfigWithManifestAliases,
  resolveFoldedPluginEntry,
  type ChannelClaimCandidate,
  type ChannelClaimantDecision,
} from "./channel-claimant-plugins.js";
import { isChannelConfigured } from "./channel-configured.js";
import { resolveChannelClaimPreferOver } from "./plugin-auto-enable.prefer-over.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const EMPTY_PLUGIN_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};

function resolveAutoEnableProviderPluginIds(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  const entries = new Map<string, string>();
  for (const plugin of registry.plugins) {
    for (const providerId of plugin.autoEnableWhenConfiguredProviders ?? []) {
      if (!entries.has(providerId)) {
        entries.set(providerId, plugin.id);
      }
    }
  }
  return Object.fromEntries(entries);
}

function canReuseUnscopedCurrentPluginMetadataSnapshot(config: OpenClawConfig): boolean {
  return normalizePluginsConfig(config.plugins).loadPaths.length === 0;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function hasConfiguredEmbeddedHarnessRuntime(
  cfg: OpenClawConfig,
  _env: NodeJS.ProcessEnv,
): boolean {
  return collectConfiguredAgentHarnessRuntimes(cfg).length > 0;
}

function resolveAgentHarnessOwnerPluginIds(
  registry: PluginManifestRegistry,
  runtime: string,
): string[] {
  const normalizedRuntime = normalizeOptionalLowercaseString(runtime);
  if (!normalizedRuntime) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      [...(plugin.activation?.onAgentHarnesses ?? []), ...(plugin.cliBackends ?? [])].some(
        (entry) => normalizeOptionalLowercaseString(entry) === normalizedRuntime,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) {
        continue;
      }
      const provider = normalizeProviderId(profile.provider ?? "");
      if (provider === normalized) {
        return true;
      }
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) {
        return true;
      }
    }
  }

  for (const { value: ref } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) {
      return true;
    }
  }

  return false;
}

// Capability detection reads the folded entry: the operator's config lives under the policy
// key while a manifest keeps its author's case, and a missed entry means no capability
// candidate — the channel-replacement capability preservation never engages.
function hasPluginOwnedWebSearchConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): boolean {
  const pluginConfig = resolveFoldedPluginEntry(cfg, pluginId, registry)?.config;
  return isRecord(pluginConfig) && isRecord(pluginConfig.webSearch);
}

function hasPluginOwnedWebFetchConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): boolean {
  const pluginConfig = resolveFoldedPluginEntry(cfg, pluginId, registry)?.config;
  return isRecord(pluginConfig) && isRecord(pluginConfig.webFetch);
}

function resolvePluginOwnedToolConfigKeys(plugin: PluginManifestRecord): string[] {
  if ((plugin.contracts?.tools?.length ?? 0) === 0) {
    return [];
  }
  const properties = isRecord(plugin.configSchema) ? plugin.configSchema.properties : undefined;
  if (!isRecord(properties)) {
    return [];
  }
  return Object.keys(properties).filter((key) => key !== "webSearch" && key !== "webFetch");
}

function hasPluginOwnedToolConfig(
  cfg: OpenClawConfig,
  plugin: PluginManifestRecord,
  registry: PluginManifestRegistry,
): boolean {
  const pluginConfig = resolveFoldedPluginEntry(cfg, plugin.id, registry)?.config;
  if (!isRecord(pluginConfig)) {
    return false;
  }
  return resolvePluginOwnedToolConfigKeys(plugin).some((key) => pluginConfig[key] !== undefined);
}

function resolveProviderPluginsWithOwnedWebSearch(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins
    .filter((plugin) => (plugin.providers?.length ?? 0) > 0)
    .filter((plugin) => (plugin.contracts?.webSearchProviders?.length ?? 0) > 0);
}

function resolveProviderPluginsWithOwnedWebFetch(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins.filter(
    (plugin) => (plugin.contracts?.webFetchProviders?.length ?? 0) > 0,
  );
}

function resolvePluginIdsForConfiguredSpeechProvider(
  providerId: string,
  registry: PluginManifestRegistry,
): string[] {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      (plugin.contracts?.speechProviders ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolvePluginsWithOwnedToolConfig(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins.filter((plugin) => (plugin.contracts?.tools?.length ?? 0) > 0);
}

function resolvePluginIdForConfiguredWebFetchProvider(
  providerId: string | undefined,
  registry: PluginManifestRegistry,
): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return registry.plugins.find(
    (plugin) =>
      plugin.origin === "bundled" &&
      (plugin.contracts?.webFetchProviders ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
  )?.id;
}

function resolvePluginIdForConfiguredWebSearchProvider(
  providerId: string | undefined,
  registry: PluginManifestRegistry,
): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return registry.plugins.find((plugin) =>
    (plugin.contracts?.webSearchProviders ?? []).some(
      (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
    ),
  )?.id;
}

function collectConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers: AmbientEnvTriggerPolicy = "allow",
): string[] {
  const configuredStateChannelIds = new Set(listBundledChannelIdsWithConfiguredState(discovery));
  return (
    listPotentialConfiguredChannelPresenceSignals(cfg, env, {
      includePersistedAuthState: false,
      discovery,
      ambientEnvTriggers,
    })
      .map((signal) => ({
        source: signal.source,
        channelId: normalizeChatChannelId(signal.channelId) ?? signal.channelId,
      }))
      .filter(({ channelId, source }) =>
        isAutoEnableConfiguredChannelSignal({
          cfg,
          env,
          channelId,
          source,
          configuredStateChannelIds,
          discovery,
        }),
      )
      .map(({ channelId }) => channelId)
      // Presence signals dedupe per SOURCE, so one channel configured through both `channels.*`
      // settings and credential env vars repeats here — and a duplicate claim candidate re-decides
      // against the fates the first one landed, overwriting its recorded per-channel decision.
      .filter((channelId, index, ids) => ids.indexOf(channelId) === index)
  );
}

function isAutoEnableConfiguredChannelSignal(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelId: string;
  source: ChannelPresenceSignalSource;
  configuredStateChannelIds: ReadonlySet<string>;
  discovery?: PluginDiscoveryResult;
}): boolean {
  if (
    params.source === "env" &&
    params.configuredStateChannelIds.has(params.channelId) &&
    !hasBundledChannelConfiguredState({
      channelId: params.channelId,
      cfg: params.cfg,
      env: params.env,
      discovery: params.discovery,
    })
  ) {
    return false;
  }
  return isChannelConfigured(params.cfg, params.channelId, params.env);
}

function hasConfiguredWebSearchProviderSelection(cfg: OpenClawConfig): boolean {
  const provider = cfg.tools?.web?.search?.provider;
  return (
    cfg.tools?.web?.search?.enabled !== false &&
    typeof provider === "string" &&
    Boolean(provider.trim())
  );
}

function hasConfiguredSpeechProviderSelection(cfg: OpenClawConfig): boolean {
  return collectConfiguredSpeechProviderIds(cfg).size > 0;
}

function hasConfiguredPluginConfigEntry(
  cfg: OpenClawConfig,
  configKey?: "webSearch" | "webFetch",
): boolean {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return (
    entries !== undefined &&
    Object.values(entries).some(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.config) &&
        (configKey === undefined || isRecord(entry.config[configKey])),
    )
  );
}

function listContainsNormalized(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeOptionalLowercaseString(entry) === expected)
  );
}

function toolPolicyReferencesBrowser(value: unknown): boolean {
  return (
    isRecord(value) &&
    (listContainsNormalized(value.allow, "browser") ||
      listContainsNormalized(value.alsoAllow, "browser"))
  );
}

function hasBrowserToolReference(cfg: OpenClawConfig): boolean {
  if (toolPolicyReferencesBrowser(cfg.tools)) {
    return true;
  }
  return listAgentEntries(cfg).some((entry) => toolPolicyReferencesBrowser(entry.tools));
}

function collectConfiguredPluginEntryIds(cfg: OpenClawConfig): string[] {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries) {
    return [];
  }
  return Object.keys(entries)
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId && !isPluginEntryExplicitlyDisabled(cfg, pluginId));
}

function hasOwnPluginEntry(cfg: OpenClawConfig, pluginId: string): boolean {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return entries !== undefined && Object.hasOwn(entries, pluginId);
}

function isPluginEntryExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function hasNonDisabledPluginEntry(cfg: OpenClawConfig, pluginId: string): boolean {
  if (!hasOwnPluginEntry(cfg, pluginId)) {
    return false;
  }
  return !isPluginEntryExplicitlyDisabled(cfg, pluginId);
}

function hasBrowserSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (cfg.browser?.enabled === false || isPluginEntryExplicitlyDisabled(cfg, "browser")) {
    return false;
  }
  if (isRecord(cfg.browser)) {
    return true;
  }
  if (hasNonDisabledPluginEntry(cfg, "browser")) {
    return true;
  }
  return hasBrowserToolReference(cfg);
}

function hasAcpxSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "acpx")) {
    return false;
  }
  if (!isRecord(cfg.acp)) {
    return false;
  }
  const backend = normalizeOptionalLowercaseString(cfg.acp.backend);
  const configured =
    cfg.acp.enabled === true ||
    (isRecord(cfg.acp.dispatch) && cfg.acp.dispatch.enabled === true) ||
    backend === "acpx";
  return configured && (!backend || backend === "acpx");
}

function hasXaiSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "xai")) {
    return false;
  }
  const pluginConfig = cfg.plugins?.entries?.xai?.config;
  return (
    isRecord(pluginConfig) &&
    (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))
  );
}

function resolveRelevantSetupAutoEnablePluginIds(cfg: OpenClawConfig): string[] {
  const pluginIds = new Set<string>(collectConfiguredPluginEntryIds(cfg));
  if (hasBrowserSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("browser");
  }
  if (hasAcpxSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("acpx");
  }
  if (hasXaiSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("xai");
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/**
 * The bundled special setups' declarative relevance, by plugin id. These predicates are
 * conservative mirrors of the plugins' own auto-enable probes; probe-less plans emit their
 * candidates from this map, and loader cache identity fingerprints it — a config toggle that
 * changes a declarative setup decision must never serve a cached registry planned without it.
 */
export function resolveDeclaredSpecialSetupRelevance(cfg: OpenClawConfig): Record<string, boolean> {
  return {
    browser: hasBrowserSetupAutoEnableRelevantConfig(cfg),
    acpx: hasAcpxSetupAutoEnableRelevantConfig(cfg),
    xai: hasXaiSetupAutoEnableRelevantConfig(cfg),
  };
}

/**
 * True when this config could produce setup-derived auto-enable candidates at all — the same
 * gate the pass uses before running setup probes. When false, a probe-skipping plan is exactly
 * the plan the runtime executes, so the ownership projection may treat its completed activation
 * facts as exhaustive.
 */
function hasSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  return (
    hasBrowserSetupAutoEnableRelevantConfig(cfg) ||
    hasAcpxSetupAutoEnableRelevantConfig(cfg) ||
    hasXaiSetupAutoEnableRelevantConfig(cfg) ||
    hasConfiguredPluginConfigEntry(cfg)
  );
}

/**
 * True when this config could produce setup-derived candidates for a plugin that actually
 * declares a setup surface — the only candidates a probe-skipping plan can miss. The pass's own
 * probe gate above stays coarse (probes are cheap reads there); the ownership projection needs
 * the sharp form, or an unrelated configured entry flips its exact-plan accounting off.
 */
export function hasRelevantSetupCandidateConfig(
  cfg: OpenClawConfig,
  registry: PluginManifestRegistry,
  manifestCandidates?: readonly PluginAutoEnableCandidate[],
): boolean {
  // A plugin whose manifest facts already yield a candidate is categorically removed from setup
  // probing (`manifestMatchedPluginIds` in the detector), so its material entry can never yield
  // a probe-derived candidate a probe-skipping plan would miss. Policy-id space like the gate's
  // other compares. The hard-coded special setup surfaces obey the same exclusion — configured
  // `xai.config.xSearch` is itself a manifest tool candidate, and probing skips it too.
  const manifestMatchedPolicyIds = new Set(
    (manifestCandidates ?? []).map((candidate) => normalizePluginPolicyId(candidate.pluginId)),
  );
  const specialSetupRelevant =
    (hasBrowserSetupAutoEnableRelevantConfig(cfg) &&
      !manifestMatchedPolicyIds.has(normalizePluginPolicyId("browser"))) ||
    (hasAcpxSetupAutoEnableRelevantConfig(cfg) &&
      !manifestMatchedPolicyIds.has(normalizePluginPolicyId("acpx"))) ||
    (hasXaiSetupAutoEnableRelevantConfig(cfg) &&
      !manifestMatchedPolicyIds.has(normalizePluginPolicyId("xai")));
  if (specialSetupRelevant) {
    return true;
  }
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries) {
    return false;
  }
  const entryPolicyIds = new Set(
    Object.keys(entries)
      // An explicitly disabled entry is categorically excluded from setup candidacy
      // (`collectConfiguredPluginEntryIds`), so it can never yield a probe-derived candidate a
      // probe-skipping plan would miss — treating it as relevant hands ownership back to
      // predictive tiers for channels the runtime pass decides by load order.
      .filter((pluginId) => !isPluginEntryExplicitlyDisabled(cfg, pluginId))
      .map(normalizePluginPolicyId),
  );
  return registry.plugins.some(
    (record) =>
      (record.setup !== undefined || record.setupSource !== undefined) &&
      // A runtime-disabled setup descriptor is categorically skipped before any probe resolves
      // (setup-registry), so it can never yield a probe-derived candidate a probe-skipping
      // plan would miss — treating it as relevant hands ownership back to predictive tiers.
      record.setup?.requiresRuntime !== false &&
      !manifestMatchedPolicyIds.has(normalizePluginPolicyId(record.id)) &&
      entryPolicyIds.has(normalizePluginPolicyId(record.id)),
  );
}

function hasPluginEntries(cfg: OpenClawConfig): boolean {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return entries !== undefined && Object.keys(entries).length > 0;
}

function hasPluginAllowlistWithMaterialEntries(cfg: OpenClawConfig): boolean {
  if (
    !Array.isArray(cfg.plugins?.allow) ||
    cfg.plugins.allow.length === 0 ||
    !hasPluginEntries(cfg)
  ) {
    return false;
  }
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries) {
    return false;
  }
  return Object.values(entries).some(hasMaterialPluginEntryConfig);
}

function hasConfiguredProviderModelOrHarness(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) {
    return true;
  }
  if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) {
    return true;
  }
  if (collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false }).length > 0) {
    return true;
  }
  return hasConfiguredEmbeddedHarnessRuntime(cfg, env);
}

function arePluginsGloballyDisabled(cfg: OpenClawConfig): boolean {
  return cfg.plugins?.enabled === false;
}

function configMayNeedPluginManifestRegistry(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (arePluginsGloballyDisabled(cfg)) {
    return false;
  }
  if (hasPluginAllowlistWithMaterialEntries(cfg)) {
    return true;
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return true;
  }
  if (hasConfiguredProviderModelOrHarness(cfg, env)) {
    return true;
  }
  if (hasConfiguredSpeechProviderSelection(cfg)) {
    return true;
  }
  if (collectConfiguredWorkerProviderIds(cfg).length > 0) {
    return true;
  }
  if (hasConfiguredWebSearchProviderSelection(cfg)) {
    return true;
  }
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return false;
  }
  for (const key of Object.keys(configuredChannels)) {
    if (key === "defaults" || key === "modelByChannel") {
      continue;
    }
    return true;
  }
  return false;
}

export function configMayNeedPluginAutoEnable(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  return resolvePluginAutoEnableReadiness(cfg, env).mayNeedAutoEnable;
}

/**
 * Whether detection may execute plugin setup modules to ask their auto-enable probes. Validation
 * and schema projections pass "skip": they must never run plugin code, and a throwing probe must
 * never abort them.
 */
export type PluginSetupProbePolicy = "execute" | "skip";

export function resolvePluginAutoEnableReadiness(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers: AmbientEnvTriggerPolicy = "allow",
  setupProbes: PluginSetupProbePolicy = "execute",
): { mayNeedAutoEnable: boolean; configuredChannelIds: string[] } {
  if (arePluginsGloballyDisabled(cfg)) {
    return { mayNeedAutoEnable: false, configuredChannelIds: [] };
  }
  const configuredChannelIds = collectConfiguredChannelIds(cfg, env, discovery, ambientEnvTriggers);
  if (hasPluginAllowlistWithMaterialEntries(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (configuredChannelIds.length > 0) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredProviderModelOrHarness(cfg, env)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredSpeechProviderSelection(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (collectConfiguredWorkerProviderIds(cfg).length > 0) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (
    hasConfiguredWebSearchProviderSelection(cfg) ||
    hasConfiguredPluginConfigEntry(cfg, "webSearch") ||
    hasConfiguredPluginConfigEntry(cfg, "webFetch")
  ) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (setupProbes === "skip" || !hasSetupAutoEnableRelevantConfig(cfg)) {
    return { mayNeedAutoEnable: false, configuredChannelIds };
  }
  return {
    mayNeedAutoEnable:
      resolvePluginSetupAutoEnableReasons({
        config: cfg,
        env,
        pluginIds: resolveRelevantSetupAutoEnablePluginIds(cfg),
      }).length > 0,
    configuredChannelIds,
  };
}

export function resolvePluginAutoEnableCandidateReason(
  candidate: PluginAutoEnableCandidate,
): string {
  switch (candidate.kind) {
    case "channel-configured":
      return `${candidate.channelId} configured`;
    case "provider-auth-configured":
      return `${candidate.providerId} auth configured`;
    case "provider-model-configured":
      return `${candidate.modelRef} model configured`;
    case "speech-provider-selected":
      return `${candidate.providerId} speech provider selected`;
    case "worker-provider-selected":
      return `${candidate.providerId} worker provider selected`;
    case "agent-harness-runtime-configured":
      return `${candidate.runtime} agent runtime configured`;
    case "web-search-provider-selected":
      return `${candidate.providerId} web search provider selected`;
    case "web-fetch-provider-selected":
      return `${candidate.providerId} web fetch provider selected`;
    case "plugin-web-search-configured":
      return `${candidate.pluginId} web search configured`;
    case "plugin-web-fetch-configured":
      return `${candidate.pluginId} web fetch configured`;
    case "plugin-tool-configured":
      return `${candidate.pluginId} tool configured`;
    case "configured-plugin-repaired":
      return `${candidate.pluginId} installed for existing configuration`;
    case "setup-auto-enable":
      return candidate.reason;
  }
  throw new Error("Unsupported plugin auto-enable candidate");
}

export function resolveConfiguredPluginAutoEnableCandidates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  configuredChannelIds?: readonly string[];
  setupProbes?: PluginSetupProbePolicy;
}): PluginAutoEnableCandidate[] {
  const changes: PluginAutoEnableCandidate[] = [];
  for (const channelId of params.configuredChannelIds ??
    collectConfiguredChannelIds(params.config, params.env)) {
    for (const pluginId of collectPluginIdsForConfiguredChannel(
      channelId,
      params.registry,
      params.env,
    )) {
      changes.push({ pluginId, kind: "channel-configured", channelId });
    }
  }

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(params.registry),
  )) {
    if (isProviderConfigured(params.config, providerId)) {
      changes.push({ pluginId, kind: "provider-auth-configured", providerId });
    }
  }

  for (const { value: modelRef } of collectConfiguredModelRefs(params.config, {
    includeChannelModelOverrides: false,
  })) {
    const owningPluginIds = resolveOwningPluginIdsForModelRef({
      model: modelRef,
      config: params.config,
      env: params.env,
      manifestRegistry: params.registry,
    });
    if (owningPluginIds?.length === 1) {
      changes.push({
        pluginId: expectDefined(owningPluginIds[0], "owning plugin ids entry at 0"),
        kind: "provider-model-configured",
        modelRef,
      });
    }
  }

  for (const providerId of collectConfiguredSpeechProviderIds(params.config)) {
    for (const pluginId of resolvePluginIdsForConfiguredSpeechProvider(
      providerId,
      params.registry,
    )) {
      changes.push({
        pluginId,
        kind: "speech-provider-selected",
        providerId,
      });
    }
  }

  for (const { pluginId, providerId } of listBundledWorkerProviderOwners(
    params.registry,
    collectConfiguredWorkerProviderIds(params.config),
  )) {
    changes.push({ pluginId, kind: "worker-provider-selected", providerId });
  }

  for (const runtime of collectConfiguredAgentHarnessRuntimes(params.config)) {
    const pluginIds = resolveAgentHarnessOwnerPluginIds(params.registry, runtime);
    for (const pluginId of pluginIds) {
      changes.push({
        pluginId,
        kind: "agent-harness-runtime-configured",
        runtime,
      });
    }
  }

  const webSearchConfig = params.config.tools?.web?.search;
  const webSearchProvider =
    webSearchConfig?.enabled !== false && typeof webSearchConfig?.provider === "string"
      ? webSearchConfig.provider
      : undefined;
  const webSearchPluginId = resolvePluginIdForConfiguredWebSearchProvider(
    webSearchProvider,
    params.registry,
  );
  if (webSearchPluginId) {
    changes.push({
      pluginId: webSearchPluginId,
      kind: "web-search-provider-selected",
      providerId: normalizeOptionalLowercaseString(webSearchProvider) ?? "",
    });
  }

  const webFetchProvider =
    typeof params.config.tools?.web?.fetch?.provider === "string"
      ? params.config.tools.web.fetch.provider
      : undefined;
  const webFetchPluginId = resolvePluginIdForConfiguredWebFetchProvider(
    webFetchProvider,
    params.registry,
  );
  if (webFetchPluginId) {
    changes.push({
      pluginId: webFetchPluginId,
      kind: "web-fetch-provider-selected",
      providerId: normalizeOptionalLowercaseString(webFetchProvider) ?? "",
    });
  }

  for (const plugin of resolveProviderPluginsWithOwnedWebSearch(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedWebSearchConfig(params.config, pluginId, params.registry)) {
      changes.push({ pluginId, kind: "plugin-web-search-configured" });
    }
  }

  for (const plugin of resolvePluginsWithOwnedToolConfig(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedToolConfig(params.config, plugin, params.registry)) {
      changes.push({ pluginId, kind: "plugin-tool-configured" });
    }
  }

  for (const plugin of resolveProviderPluginsWithOwnedWebFetch(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedWebFetchConfig(params.config, pluginId, params.registry)) {
      changes.push({ pluginId, kind: "plugin-web-fetch-configured" });
    }
  }

  if (params.setupProbes !== "skip" && hasSetupAutoEnableRelevantConfig(params.config)) {
    const manifestMatchedPluginIds = new Set(changes.map((entry) => entry.pluginId));
    const setupPluginIds = resolveRelevantSetupAutoEnablePluginIds(params.config).filter(
      (pluginId) => !manifestMatchedPluginIds.has(pluginId),
    );
    for (const entry of resolvePluginSetupAutoEnableReasons({
      config: params.config,
      env: params.env,
      pluginIds: setupPluginIds,
    })) {
      changes.push({
        pluginId: entry.pluginId,
        kind: "setup-auto-enable",
        reason: entry.reason,
      });
    }
  } else if (params.setupProbes === "skip") {
    // Probe-less plans still carry the bundled special setups' DECLARATIVE decisions: these
    // relevance predicates are conservative mirrors of the plugins' own auto-enable probes (a
    // mirror must never fire when its probe declines, or projections kill claimants the runtime
    // keeps), so ownership, suppression, and fingerprints rank the same setup-derived claimant
    // fates the applied pass produces — without executing plugin code here.
    const manifestMatchedPluginIds = new Set(changes.map((entry) => entry.pluginId));
    const declaredSpecialSetups = Object.entries(
      resolveDeclaredSpecialSetupRelevance(params.config),
    );
    for (const [pluginId, declared] of declaredSpecialSetups) {
      if (
        declared &&
        !manifestMatchedPluginIds.has(pluginId) &&
        params.registry.plugins.some((record) => normalizePluginPolicyId(record.id) === pluginId)
      ) {
        changes.push({
          pluginId,
          kind: "setup-auto-enable",
          reason: "declared setup configuration",
        });
      }
    }
  }

  return changes;
}

/**
 * The config key an apply-phase write must land on. Operator entries are keyed by the derived
 * policy id while a manifest keeps its author's case: an exact declared-id write beside an
 * existing case-variant key creates a duplicate whose normalization order can fold an appended
 * `enabled: true` over the operator's `enabled: false`. Reuse the operator's key when one
 * matches through the policy id; otherwise keep the declared id.
 */
function resolvePluginEntryKey(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): string {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries || Object.hasOwn(entries, pluginId)) {
    return pluginId;
  }
  // Legacy aliases included: an operator's entry under a manifest's documented legacyPluginIds
  // key IS this plugin's entry once the runtime normalizer folds them, so a write beside it
  // would mint a duplicate the folding can invert.
  const selectionIds = collectPluginSelectionPolicyIds(registry, pluginId);
  for (const key of Object.keys(entries)) {
    if (selectionIds.has(normalizePluginPolicyId(key))) {
      return key;
    }
  }
  return pluginId;
}

function disableImplicitPreferredOverPlugin(params: {
  config: OpenClawConfig;
  pluginId: string;
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  // Upstream's explicit-selection guard lives in the resolver here: explicitly selected
  // plugins land `supersede-keep`, which the apply loop never routes to this disable write.
  // A built-in channel id can remain in the static channel catalog after its
  // bundled plugin has been externalized. Do not synthesize a disabled entry
  // for that owner unless it is still present in the runtime manifest set.
  // Otherwise registry alias normalization can fold the stale channel id back
  // onto the external owner and override its explicit enabled entry.
  if (!params.manifestRegistry.plugins.some((plugin) => plugin.id === params.pluginId)) {
    return params.config;
  }
  if (
    !normalizeChatChannelId(params.pluginId) &&
    !isKnownPluginId(params.pluginId, params.manifestRegistry)
  ) {
    return params.config;
  }
  const entryKey = resolvePluginEntryKey(params.config, params.pluginId, params.manifestRegistry);
  const existingEntry = params.config.plugins?.entries?.[entryKey];
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      entries: {
        ...params.config.plugins?.entries,
        [entryKey]: {
          ...asOptionalObjectRecord(existingEntry),
          enabled: false,
        },
      },
    },
  };
}

function isBuiltInChannelAlreadyEnabled(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return asOptionalRecord(channels?.[channelId])?.enabled === true;
}

function resolveAutoEnableChannelId(params: {
  entry: PluginAutoEnableCandidate;
  manifestRegistry: PluginManifestRegistry;
}): string | null {
  if (params.entry.kind === "configured-plugin-repaired") {
    return null;
  }
  const plugin = params.manifestRegistry.plugins.find(
    (record) => record.id === params.entry.pluginId,
  );
  if (plugin && plugin.origin !== "bundled") {
    if (params.entry.kind !== "channel-configured") {
      return null;
    }
    const channelId = normalizeManifestChannelId(params.entry.channelId);
    if ((plugin.channels ?? []).some((id) => normalizeManifestChannelId(id) === channelId)) {
      return null;
    }
  }
  const builtInChannelId = normalizeChatChannelId(params.entry.pluginId);
  if (builtInChannelId) {
    return builtInChannelId;
  }
  if (params.entry.kind !== "channel-configured") {
    return null;
  }
  if (plugin?.origin !== "bundled") {
    return null;
  }
  const channelId = normalizeManifestChannelId(params.entry.channelId);
  return (plugin.channels ?? []).some((id) => normalizeManifestChannelId(id) === channelId)
    ? channelId
    : null;
}

function registerPluginEntry(
  cfg: OpenClawConfig,
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): OpenClawConfig {
  const builtInChannelId = resolveAutoEnableChannelId({ entry, manifestRegistry });
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...asOptionalRecord(channels?.[builtInChannelId]),
          enabled: true,
        },
      },
    };
  }

  const entryKey = resolvePluginEntryKey(cfg, entry.pluginId, manifestRegistry);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [entryKey]: {
          ...(cfg.plugins?.entries?.[entryKey] as Record<string, unknown> | undefined),
          enabled: true,
        },
      },
    },
  };
}

function isKnownPluginId(pluginId: string, manifestRegistry: PluginManifestRegistry): boolean {
  if (normalizeChatChannelId(pluginId)) {
    return true;
  }
  // Config entries and policy lists are keyed by the derived policy id while a manifest keeps
  // its author's case, so known-ness must compare that key: an exact read rejects the operator's
  // normalized entry for a mixed-case install and the allowlist repair skips the very plugin the
  // operator configured.
  const policyId = normalizePluginPolicyId(pluginId);
  return (
    manifestRegistry.plugins.some((plugin) => normalizePluginPolicyId(plugin.id) === policyId) ||
    isOfficialExternalPluginId(pluginId)
  );
}

function materializeConfiguredPluginEntryAllowlist(params: {
  config: OpenClawConfig;
  changes: string[];
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  let next = params.config;
  const allow = next.plugins?.allow;
  const entries = asOptionalObjectRecord(next.plugins?.entries);
  if (!Array.isArray(allow) || allow.length === 0 || !entries) {
    return next;
  }

  for (const pluginId of Object.keys(entries).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const entry = entries[pluginId];
    // The raw authored key may be a legacy alias or case variant: runtime normalization folds
    // the entry onto the CURRENT plugin id, so the repair's known-plugin and allow-membership
    // checks must run against that fold — a raw-alias lookup treats the key as unknown, skips
    // the repair, and leaves the configured plugin excluded by the very allowlist it maintains.
    const resolvedPluginId = resolvePluginKeyThroughRegistryAliases(
      pluginId,
      params.manifestRegistry,
    );
    const selectionIds = collectPluginSelectionPolicyIds(params.manifestRegistry, resolvedPluginId);
    if (
      !hasMaterialPluginEntryConfig(entry) ||
      isPluginPolicyDenied(next, resolvedPluginId, params.manifestRegistry) ||
      isPluginPolicyDisabled(next, resolvedPluginId, params.manifestRegistry) ||
      // Loading compares allow entries through the plugin's selection policy ids — legacy
      // aliases included — so a case-variant or legacy allow entry already admits this plugin;
      // appending the entry key would only duplicate it.
      allow.some((allowedId) => selectionIds.has(normalizePluginPolicyId(allowedId))) ||
      !isKnownPluginId(resolvedPluginId, params.manifestRegistry)
    ) {
      continue;
    }
    next = ensurePluginAllowlisted(next, resolvedPluginId);
    params.changes.push(`${resolvedPluginId} plugin config present, added to plugin allowlist.`);
  }

  return next;
}

function resolveChannelAutoEnableDisplayLabel(
  entry: Extract<PluginAutoEnableCandidate, { kind: "channel-configured" }>,
  manifestRegistry: PluginManifestRegistry,
): string | undefined {
  const builtInChannelId = normalizeChatChannelId(entry.channelId);
  const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
  return (
    (builtInChannelId ? findChatChannelMeta(builtInChannelId)?.label : undefined) ??
    plugin?.channelConfigs?.[entry.channelId]?.label ??
    plugin?.channelCatalogMeta?.label
  );
}

function formatAutoEnableChange(
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): string {
  if (entry.kind === "channel-configured") {
    const label = resolveChannelAutoEnableDisplayLabel(entry, manifestRegistry);
    if (label) {
      return `${label} configured, enabled automatically.`;
    }
  }
  return `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`;
}

export function resolvePluginAutoEnableManifestRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  if (params.manifestRegistry) {
    return params.manifestRegistry;
  }
  if (!configMayNeedPluginManifestRegistry(params.config, params.env)) {
    return EMPTY_PLUGIN_MANIFEST_REGISTRY;
  }
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    allowWorkspaceScopedSnapshot: true,
  });
  const policyCompatibleCurrentSnapshot =
    currentSnapshot ??
    (() => {
      if (!canReuseUnscopedCurrentPluginMetadataSnapshot(params.config)) {
        return undefined;
      }
      const snapshot = getCurrentPluginMetadataSnapshot({
        env: params.env,
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      });
      return snapshot?.policyHash === resolveInstalledPluginIndexPolicyHash(params.config)
        ? snapshot
        : undefined;
    })();
  return (
    policyCompatibleCurrentSnapshot?.manifestRegistry ??
    loadPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
    }).manifestRegistry
  );
}

/** Auto-enable's completed activation pass plus the channel claimant decisions it took. */
type PluginAutoEnablePlan = PluginAutoEnableResult & {
  channelDecisions: ReadonlyMap<string, ReadonlyMap<string, ChannelClaimantDecision>>;
  // Plugin-level end-state liveness from the completed resolution: capability candidates decide
  // a plugin's fate globally without a per-channel decision, and the ownership projection needs
  // that fact to rank such claimants by load order.
  isClaimantLive: (pluginId: string) => boolean;
};

type ChannelFallbackReselection = { index: number; candidate: PluginAutoEnableCandidate };

/** True when the channel's own config carries `enabled: false` — the operator turned it off. */
const isChannelExplicitlyDisabled = (cfg: OpenClawConfig, channelId: string): boolean =>
  asOptionalRecord((cfg.channels as Record<string, unknown> | undefined)?.[channelId])?.enabled ===
  false;

type ChannelCandidateGroup = {
  channelId: string;
  lastIndex: number;
  live: boolean;
  policyIds: Set<string>;
  /** Non-forbidden claimants the pass killed, in candidate order — re-grounding pin targets. */
  deadClaimantPolicyIds: string[];
};

/**
 * Selects a live anchor for a configured channel no remedy could serve: the group is unowned,
 * fallback re-selection found no other claimant, its re-grounding pin was rejected, and the
 * registry holds exactly one activatable claimant for it. That claimant must not stay
 * plugin-globally disabled by a supersession from a sibling channel — its death orphans this
 * channel with no recourse.
 */
function selectSoleClaimantAnchor(params: {
  groups: ReadonlyMap<string, ChannelCandidateGroup>;
  config: OpenClawConfig;
  registry: PluginManifestRegistry;
  env: NodeJS.ProcessEnv;
  preferOverCache: Map<string, string[]>;
  anchored: ReadonlySet<string>;
  isClaimantLive: (pluginId: string) => boolean;
}): string | null {
  const sourceForbidden = (pluginId: string): boolean =>
    isPluginPolicyDenied(params.config, pluginId, params.registry) ||
    isPluginPolicyDisabled(params.config, pluginId, params.registry);
  // preferOver edges between ACTIVATABLE claimants over CONFIGURED channels, by policy id. A
  // victim inside a replacement cycle stands down with its grounded cycle — its channel is
  // legal-unowned by the seniority grounding design, and anchoring it would flip-flop the
  // grounded assignment. Only a victim whose killers it cannot reach back (a non-cyclic kill)
  // anchors. Forbidden plugins and unconfigured channel claims never participate in resolution,
  // so edges through either are synthetic: they must not fabricate a cycle that suppresses the
  // anchor and orphans the channel.
  let edges: Map<string, Set<string>> | undefined;
  const edgesByPolicyId = (): Map<string, Set<string>> => {
    if (edges) {
      return edges;
    }
    edges = new Map();
    for (const record of params.registry.plugins) {
      if (sourceForbidden(record.id)) {
        continue;
      }
      const from = normalizePluginPolicyId(record.id);
      for (const channelId of record.channels ?? []) {
        const groupId = normalizeManifestChannelId(channelId);
        // Only claims that became CANDIDATES participate: a registry claimant a channel's
        // collection omitted (first-claimant selection picked another) was never decided, so
        // its edges cannot ground a cycle.
        if (!params.groups.get(groupId)?.policyIds.has(from)) {
          continue;
        }
        for (const target of resolveChannelClaimPreferOver({
          pluginId: record.id,
          channelId: groupId,
          env: params.env,
          registry: params.registry,
          cache: params.preferOverCache,
        })) {
          if (sourceForbidden(target)) {
            continue;
          }
          const into = edges.get(from) ?? new Set();
          into.add(normalizePluginPolicyId(target));
          edges.set(from, into);
        }
      }
    }
    return edges;
  };
  // A kill is cycle-grounded — and the anchor stands down — only when the victim shares a
  // replacement cycle (an SCC of the participating-claim digraph) with a LIVE killer and that
  // cycle is intact: every dead member died to in-cycle edges. A dead relay with a live killer
  // OUTSIDE the cycle can never re-form the loop at runtime, so such an externally broken
  // cycle must not suppress the last-resort anchor.
  const reachableFrom = (start: string, graph: Map<string, Set<string>>): Set<string> => {
    const reachable = new Set<string>();
    const frontier = [...(graph.get(start) ?? [])];
    while (frontier.length > 0) {
      const nextId = frontier.pop();
      if (nextId === undefined || reachable.has(nextId)) {
        continue;
      }
      reachable.add(nextId);
      frontier.push(...(graph.get(nextId) ?? []));
    }
    return reachable;
  };
  const isCyclicKill = (policyId: string): boolean => {
    const graph = edgesByPolicyId();
    const reversed = new Map<string, Set<string>>();
    for (const [from, targets] of graph) {
      for (const target of targets) {
        const into = reversed.get(target) ?? new Set<string>();
        into.add(from);
        reversed.set(target, into);
      }
    }
    const forward = reachableFrom(policyId, graph);
    const backward = reachableFrom(policyId, reversed);
    const cycleMembers = new Set([policyId, ...[...forward].filter((id) => backward.has(id))]);
    // SCC membership alone establishes the cycle: mid-worklist liveness inside a grounded
    // cycle shifts with each re-resolve, so the killer's liveness must not gate suppression.
    const killerInCycle = [...cycleMembers].some(
      (member) => member !== policyId && graph.get(member)?.has(policyId) === true,
    );
    if (!killerInCycle) {
      return false;
    }
    // The victim itself counts: a live out-of-cycle plugin killing the victim directly breaks
    // the cycle just as an external kill of any relay does.
    const externallyBroken = [...cycleMembers].some(
      (member) =>
        !params.isClaimantLive(member) &&
        [...(reversed.get(member) ?? [])].some(
          (killer) => !cycleMembers.has(killer) && params.isClaimantLive(killer),
        ),
    );
    return !externallyBroken;
  };
  for (const [groupId, group] of params.groups) {
    if (!isUnownedGroup(group)) {
      continue;
    }
    const claimants = params.registry.plugins.filter(
      (record) =>
        (record.channels ?? []).some((id) => normalizeManifestChannelId(id) === groupId) &&
        !sourceForbidden(record.id),
    );
    // Preserve at least one owner: the first activatable claimant in discovery order whose kill
    // is non-cyclic — the same seniority the runtime's load order grants it. Several claimants
    // can all die to distinct sibling-channel edges with every pin vetoed; restricting the
    // anchor to a sole registry claimant left such a channel orphaned all the same.
    for (const claimant of claimants) {
      const policyId = normalizePluginPolicyId(claimant.id);
      if (!params.anchored.has(policyId) && !isCyclicKill(policyId)) {
        return policyId;
      }
    }
  }
  return null;
}

/** Configured-channel candidate groups with their end-state liveness, in first-seen order. */
function scanConfiguredChannelGroups(params: {
  candidates: readonly PluginAutoEnableCandidate[];
  claims: readonly ChannelClaimCandidate[];
  decisions: readonly ChannelClaimantDecision[];
  isLiveDecision: (claim: ChannelClaimCandidate, decision: ChannelClaimantDecision) => boolean;
  config: OpenClawConfig;
  registry: PluginManifestRegistry;
}): Map<string, ChannelCandidateGroup> {
  const sourceForbidden = (pluginId: string): boolean =>
    isPluginPolicyDenied(params.config, pluginId, params.registry) ||
    isPluginPolicyDisabled(params.config, pluginId, params.registry);
  const groups = new Map<string, ChannelCandidateGroup>();
  for (const [index, entry] of params.candidates.entries()) {
    if (entry.kind !== "channel-configured") {
      continue;
    }
    const groupId = normalizeManifestChannelId(entry.channelId);
    const group = groups.get(groupId) ?? {
      channelId: entry.channelId,
      lastIndex: index,
      live: false,
      policyIds: new Set<string>(),
      deadClaimantPolicyIds: [],
    };
    group.lastIndex = index;
    const policyId = normalizePluginPolicyId(entry.pluginId);
    group.policyIds.add(policyId);
    // Liveness reads THIS CLAIM'S decision, not the plugin's end-state fate: a capability can
    // keep a plugin alive while its claim on this channel landed suppressed — that claim does
    // not serve the channel, and counting it live would leave the group without the remedies
    // that give it a registered owner. (A live plugin whose claim decision is enable — the
    // capability-preserved multi-channel case — still counts through the decision itself.)
    const claim = params.claims[index];
    const decision = params.decisions[index];
    if (claim !== undefined && decision !== undefined && params.isLiveDecision(claim, decision)) {
      group.live = true;
    } else if (!sourceForbidden(entry.pluginId)) {
      if (!group.deadClaimantPolicyIds.includes(policyId)) {
        group.deadClaimantPolicyIds.push(policyId);
      }
    }
    groups.set(groupId, group);
  }
  return groups;
}

// A configured channel with no live claimant is unowned regardless of HOW its candidates died:
// operator-forbidden candidates also leave it unowned while an allowed uncollected claimant may
// exist — disabling specific plugins is not disabling the channel. Both remedies stay
// operator-faithful on their own: re-selection skips forbidden registry claimants and pins target
// only pass-killed claimants, so a channel whose every claimant the operator forbade is left
// exactly as forbidden.
const isUnownedGroup = (group: ChannelCandidateGroup): boolean => !group.live;

/**
 * Selects the next claimant for a configured channel whose collected candidates all landed dead
 * through the pass itself. `collectPluginIdsForConfiguredChannel` collects only the
 * discovery-first claimant when no same-channel replacement edge exists, so a cross-channel
 * supersession can kill a channel's only candidate while an activatable claimant was never
 * considered — the channel would end silently unowned. The next claimant in discovery order joins
 * the channel's candidates, exactly the selection the pass would have made had the dead claimant
 * not been collected first. This fires for operator-forbidden candidates too (forbidding a plugin
 * is not forbidding its channel); the registry scan below skips forbidden claimants, so a channel
 * whose every claimant the operator forbade stays untouched.
 */
function selectChannelFallbackReselection(params: {
  groups: ReadonlyMap<string, ChannelCandidateGroup>;
  config: OpenClawConfig;
  registry: PluginManifestRegistry;
  isClaimantActive: (record: PluginManifestRecord) => boolean;
}): ChannelFallbackReselection | null {
  const sourceForbidden = (pluginId: string): boolean =>
    isPluginPolicyDenied(params.config, pluginId, params.registry) ||
    isPluginPolicyDisabled(params.config, pluginId, params.registry);
  for (const [groupId, group] of params.groups) {
    if (!isUnownedGroup(group)) {
      continue;
    }
    const eligible = params.registry.plugins.filter(
      (record) =>
        (record.channels ?? []).some((id) => normalizeManifestChannelId(id) === groupId) &&
        !group.policyIds.has(normalizePluginPolicyId(record.id)) &&
        !sourceForbidden(record.id),
    );
    // An omitted claimant that is ALREADY active in the completed config outranks discovery
    // order: selecting an earlier-registry inactive fallback beside it would double-register the
    // channel and validate keys for a plugin the runtime never picks.
    const record = eligible.find(params.isClaimantActive) ?? eligible[0];
    if (record) {
      return {
        index: group.lastIndex + 1,
        candidate: { pluginId: record.id, kind: "channel-configured", channelId: group.channelId },
      };
    }
  }
  return null;
}

/**
 * Selects a re-grounding pin for a configured channel that stays unowned after fallback
 * re-selection exhausts the registry: grounding a replacement cycle by discovery order can
 * plugin-globally disable the sole claimant of a sibling configured channel, while grounding the
 * same cycle on that claimant keeps every channel served. The pass replays with the dead claimant
 * pinned live; the planner accepts the replay only when the channel revives and no channel that
 * was owned goes unowned, so a rejected pin can never trade one served channel for another.
 */
function selectCycleGroundingPin(params: {
  groups: ReadonlyMap<string, ChannelCandidateGroup>;
  pinnedLive: ReadonlySet<string>;
  rejectedPins: ReadonlySet<string>;
}): { groupId: string; pin: string } | null {
  for (const [groupId, group] of params.groups) {
    if (!isUnownedGroup(group)) {
      continue;
    }
    for (const policyId of group.deadClaimantPolicyIds) {
      if (!params.pinnedLive.has(policyId) && !params.rejectedPins.has(policyId)) {
        return { groupId, pin: policyId };
      }
    }
  }
  return null;
}

/**
 * Executes auto-enable's ordered pass in two phases. The resolve phase decides every candidate
 * against one coherent end state (`createChannelClaimantResolution`); the apply phase then writes
 * enables, supersede-disables, and the material-entry allowlist repair in candidate order.
 * Auto-enable applies the returned config; the channel schema collector projects validation
 * ownership from `channelDecisions` instead of re-deriving each channel in isolation against the
 * unchanged source config.
 */
export function planPluginAutoEnable(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
  /**
   * Config whose entries count as OPERATOR selections. The loader replans over the completed
   * config, where the pass's own generated `enabled: true` entries would read as explicit
   * choices and turn every implicit supersession into a keep; it passes the authored activation
   * source instead. Defaults to `config` for the validation projection and the apply pass.
   */
  selectionConfig?: OpenClawConfig;
}): PluginAutoEnablePlan {
  const sourceConfig = params.config ?? {};
  const selectionConfig = params.selectionConfig ?? sourceConfig;
  let next = sourceConfig;
  const changes: string[] = [];
  const autoEnabledReasons = new Map<string, string[]>();
  const channelDecisions = new Map<string, Map<string, ChannelClaimantDecision>>();

  if (next.plugins?.enabled === false) {
    return {
      config: next,
      changes,
      autoEnabledReasons: {},
      channelDecisions,
      isClaimantLive: () => false,
    };
  }

  // A candidate that names no channel resolves supersession through its plugin id, the key its
  // catalog and built-in replacement metadata are declared under.
  const toClaimCandidate = (entry: PluginAutoEnableCandidate): ChannelClaimCandidate => ({
    pluginId: entry.pluginId,
    channelId: entry.kind === "channel-configured" ? entry.channelId : entry.pluginId,
    channelClaim: entry.kind === "channel-configured",
  });

  // Kept-claim liveness must read the activation state the COMPLETED config produces, and the
  // final allowlist repair below can activate a kept claimant. Dry-running the repair on the
  // source config yields the same additions the post-loop run lands: a material entry makes a
  // plugin explicitly selected, so the pass can only keep it — never disable it or enable it
  // without allowlisting it inline — and entries the pass creates are either non-material
  // (enabled: false) or already allowlisted.
  const keptActivationConfig = materializeConfiguredPluginEntryAllowlist({
    config: sourceConfig,
    changes: [],
    manifestRegistry: params.manifestRegistry,
  });
  // Alias-aware like every completed-activation read: an entry under a documented legacy id
  // folds onto the current plugin before the activation check below consumes it.
  const keptActivationPlugins = normalizePluginsConfigWithManifestAliases(
    keptActivationConfig.plugins,
    params.manifestRegistry,
  );
  // "Already active" for re-selection preference means operator-signaled: an explicit entry the
  // completed config activates, or a configured capability candidacy this pass enables. Default
  // activation (a global install with no entry) does not count — preferring it would freeze the
  // discovery-order selection the remedies exist to complete.
  const isPreferredFallbackClaimant = (record: PluginManifestRecord): boolean =>
    (isPluginSelectedWithAliases(sourceConfig.plugins, record.id, params.manifestRegistry) &&
      isActivatedManifestOwner({
        plugin: record,
        normalizedConfig: keptActivationPlugins,
        rootConfig: keptActivationConfig,
      })) ||
    capabilityPolicyIds.has(normalizePluginPolicyId(record.id));
  const resolveDecisions = (
    claims: readonly ChannelClaimCandidate[],
    pinnedLive: ReadonlySet<string>,
  ) => {
    const resolution = createChannelClaimantResolution({
      candidates: claims,
      config: sourceConfig,
      selectionConfig,
      keptActivationConfig,
      env: params.env,
      registry: params.manifestRegistry,
      pinnedLiveClaimants: pinnedLive,
    });
    return {
      claims,
      decisions: claims.map((claim) => resolution.decide(claim)),
      isLiveDecision: resolution.isLiveDecision,
      isClaimantLive: resolution.isClaimantLive,
    };
  };

  // Decisions are a pure function of the candidate list, pins, and the fixed configs above, so
  // the worklist recomputes them until every configured channel is live or both remedies exhaust:
  // fallback re-selection appends a never-considered claimant first; when the registry has none,
  // a re-grounding pin replays the pass with a pass-killed claimant live, accepted only when the
  // unowned channel revives and every owned channel stays owned.
  // A channel the operator explicitly disabled contributes no claims at all: the runtime never
  // starts it, so its claimants are neither enabled on its behalf nor allowed to supersede
  // plugins serving enabled channels. Filtering before the pass — not just in repair scanning —
  // keeps a disabled channel's replacement claim from globally disabling a sibling channel's
  // sole claimant (whose re-grounding pin the live killer would rightly veto).
  const candidates = params.candidates.filter(
    (entry) =>
      entry.kind !== "channel-configured" ||
      !isChannelExplicitlyDisabled(sourceConfig, entry.channelId),
  );
  // Plugins with a configured capability candidate: their channel claims may lose ownership, but the
  // capability keeps them loaded: no supersede-disable write, and re-selection treats them as
  // already-active claimants.
  const capabilityPolicyIds = new Set(
    candidates
      .filter((entry) => entry.kind !== "channel-configured")
      .map((entry) => normalizePluginPolicyId(entry.pluginId)),
  );

  // Last-resort orphan guard: when a configured channel stays unowned after fallback
  // re-selection and re-grounding both exhaust, and its only activatable registry claimant was
  // pass-killed from a sibling channel, that claimant anchors live. Enablement is plugin-global,
  // so the takeover that killed it simply fails — exactly what the runtime's first-wins
  // registration does. Anchors stay out of the worklist's pin set so pin acceptance never
  // evaluates them as trial pins, and they never fire while the ordinary remedies can serve.
  const anchoredLive = new Set<string>();
  const withSoleClaimantAnchors = (pins: ReadonlySet<string>): ReadonlySet<string> =>
    anchoredLive.size === 0 ? pins : new Set([...anchoredLive, ...pins]);

  const pinnedLive = new Set<string>();
  const rejectedPins = new Set<string>();
  const pinPreferOverCache = new Map<string, string[]>();
  let resolved = resolveDecisions(
    candidates.map(toClaimCandidate),
    withSoleClaimantAnchors(pinnedLive),
  );
  const scanGroups = (scanned: typeof resolved) =>
    scanConfiguredChannelGroups({
      candidates,
      claims: scanned.claims,
      decisions: scanned.decisions,
      isLiveDecision: scanned.isLiveDecision,
      config: sourceConfig,
      registry: params.manifestRegistry,
    });
  for (;;) {
    const groups = scanGroups(resolved);
    const fallback = selectChannelFallbackReselection({
      groups,
      config: sourceConfig,
      registry: params.manifestRegistry,
      isClaimantActive: isPreferredFallbackClaimant,
    });
    if (fallback) {
      candidates.splice(fallback.index, 0, fallback.candidate);
      resolved = resolveDecisions(
        candidates.map(toClaimCandidate),
        withSoleClaimantAnchors(pinnedLive),
      );
      continue;
    }
    const grounding = selectCycleGroundingPin({ groups, pinnedLive, rejectedPins });
    if (!grounding) {
      const anchor = selectSoleClaimantAnchor({
        groups,
        config: sourceConfig,
        registry: params.manifestRegistry,
        env: params.env,
        preferOverCache: pinPreferOverCache,
        anchored: anchoredLive,
        isClaimantLive: resolved.isClaimantLive,
      });
      if (!anchor) {
        break;
      }
      anchoredLive.add(anchor);
      resolved = resolveDecisions(
        candidates.map(toClaimCandidate),
        withSoleClaimantAnchors(pinnedLive),
      );
      continue;
    }
    const trialPins = new Set([...pinnedLive, grounding.pin]);
    const trialClaims = candidates.map(toClaimCandidate);
    const trial = resolveDecisions(trialClaims, withSoleClaimantAnchors(trialPins));
    const trialGroups = scanGroups(trial);
    // A pin sticks only when every claim that prefers over a pinned plugin ends dead: a live
    // preferring claim means the runtime's next pass would supersede the pinned plugin again, so
    // accepting the replay would record a liveness the completed state itself contradicts.
    const pinContradicted = trialClaims.some((claim, index) => {
      const decision = expectDefined(trial.decisions[index], "trial decision at claim index");
      if (!trial.isLiveDecision(claim, decision)) {
        return false;
      }
      const preferOver = resolveChannelClaimPreferOver({
        pluginId: claim.pluginId,
        channelId: claim.channelId,
        env: params.env,
        registry: params.manifestRegistry,
        cache: pinPreferOverCache,
      });
      return [...trialPins].some((pin) => declaresPluginPreferenceOver(preferOver, pin));
    });
    const acceptable =
      !pinContradicted &&
      !isUnownedGroup(expectDefined(trialGroups.get(grounding.groupId), "pinned group")) &&
      [...groups.entries()].every(
        ([groupId, group]) =>
          isUnownedGroup(group) ||
          !isUnownedGroup(expectDefined(trialGroups.get(groupId), "trial group")),
      );
    if (acceptable) {
      pinnedLive.add(grounding.pin);
      resolved = trial;
    } else {
      rejectedPins.add(grounding.pin);
    }
  }

  for (const [index, entry] of candidates.entries()) {
    const builtInChannelId = resolveAutoEnableChannelId({
      entry,
      manifestRegistry: params.manifestRegistry,
    });
    const decision = expectDefined(resolved.decisions[index], "decision at candidate index");
    // Only channel claims project schema ownership; other kinds shape decisions through the
    // shared candidate set, and a pluginId-keyed bucket must not mask a channel's claimants.
    // A duplicate candidate re-evaluates against the fates earlier occurrences landed, so the
    // last decision reflects the completed state.
    if (entry.kind === "channel-configured") {
      const channelId = normalizeManifestChannelId(entry.channelId);
      const decisions = channelDecisions.get(channelId) ?? new Map();
      decisions.set(entry.pluginId, decision);
      channelDecisions.set(channelId, decisions);
    }
    if (decision === "forbidden" || decision === "supersede-keep") {
      continue;
    }
    if (decision === "supersede-disable") {
      // A plugin with a configured capability candidate stays loaded: the replacement takes the
      // channel (this claim's decision stands for ownership) while the capability's own enable
      // keeps the plugin — writing `enabled: false` here would silently remove a provider or
      // tool the operator configured. A claimant the pass itself preserved (anchored or pinned
      // for a sibling channel) is equally live: suppression of this claim stands while the
      // plugin keeps serving the channel that anchored it, so no disable write either.
      if (
        !capabilityPolicyIds.has(normalizePluginPolicyId(entry.pluginId)) &&
        !resolved.isClaimantLive(entry.pluginId)
      ) {
        next = disableImplicitPreferredOverPlugin({
          config: next,
          pluginId: entry.pluginId,
          manifestRegistry: params.manifestRegistry,
        });
      }
      continue;
    }

    const allow = next.plugins?.allow;
    const hasRestrictiveAllowlist = Array.isArray(allow) && allow.length > 0;
    // Allow entries are keyed by the derived policy id once config is normalized, so membership
    // must compare the plugin's selection policy ids — legacy aliases included: an exact read
    // misses the operator's normalized or legacy-keyed entry and appends a duplicate beside it
    // that outlives the operator's original entry.
    const entrySelectionIds = collectPluginSelectionPolicyIds(
      params.manifestRegistry,
      entry.pluginId,
    );
    const allowMissing =
      hasRestrictiveAllowlist &&
      !allow.some((allowed) => entrySelectionIds.has(normalizePluginPolicyId(allowed)));
    const alreadyEnabled =
      builtInChannelId != null
        ? isBuiltInChannelAlreadyEnabled(next, builtInChannelId)
        : resolveFoldedPluginEntry(next, entry.pluginId, params.manifestRegistry)?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }

    next = registerPluginEntry(next, entry, params.manifestRegistry);
    // allowMissing already compared the alias-aware selection ids: an allow entry under a
    // documented legacy id admits the plugin at load, so appending the current id beside it
    // would leave the plugin allowed even after the operator removes their original entry.
    if (allowMissing) {
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    const reason = resolvePluginAutoEnableCandidateReason(entry);
    autoEnabledReasons.set(entry.pluginId, [
      ...(autoEnabledReasons.get(entry.pluginId) ?? []),
      reason,
    ]);
    changes.push(formatAutoEnableChange(entry, params.manifestRegistry));
  }

  next = materializeConfiguredPluginEntryAllowlist({
    config: next,
    changes,
    manifestRegistry: params.manifestRegistry,
  });

  const autoEnabledReasonRecord: Record<string, string[]> = Object.create(null);
  for (const [pluginId, reasons] of autoEnabledReasons) {
    if (!isBlockedObjectKey(pluginId)) {
      autoEnabledReasonRecord[pluginId] = [...reasons];
    }
  }

  return {
    config: next,
    changes,
    autoEnabledReasons: autoEnabledReasonRecord,
    channelDecisions,
    isClaimantLive: resolved.isClaimantLive,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
