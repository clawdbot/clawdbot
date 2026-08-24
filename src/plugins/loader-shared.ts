import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { collectRuntimeChannelOwnership } from "../config/channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "../config/channel-ownership-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activateContextEngineRegistrations } from "../context-engine/registry.js";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "../memory-host-sdk/dreaming.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { normalizeCededChannelId } from "./channel-validation.js";
import {
  resolveEffectiveEnableState,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
  type PluginActivationState,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate } from "./discovery.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { collectPluginManifestCompatCodes } from "./installed-plugin-index-record-builder.js";
import { createPluginRecord } from "./loader-records.js";
import type { PluginLoadOptions, PluginRuntimeSubagentMode } from "./loader-types.js";
import {
  isPluginManifestInstallOwnerAmbiguous,
  resolvePluginManifestInstallOwner,
} from "./manifest-install-owner.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  captureActivePluginRegistrySnapshot,
  commitStagedPluginRegistry,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "./runtime.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import { hasKind } from "./slots.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { PluginLogger } from "./types.js";

export function createPluginLoaderLogger(): PluginLogger {
  return createSubsystemLogger("plugins");
}

export function detailPluginStartupTrace(
  startupTrace: PluginLoadOptions["startupTrace"] | undefined,
  pluginId: string,
  metrics: ReadonlyArray<readonly [string, number | string]>,
): void {
  startupTrace?.detail(
    `plugins.gateway-load.plugin.${encodeStartupTraceSegment(pluginId)}`,
    metrics,
  );
}

export type AuthorizedDreamingSidecar = {
  engineId: string;
  selectedMemoryPluginId: string;
};

function resolveDreamingSidecarEngineId(params: {
  cfg: OpenClawConfig;
  memorySlot: string | null | undefined;
}): string | null {
  const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(params.memorySlot);
  if (
    !normalizedMemorySlot ||
    normalizedMemorySlot === "none" ||
    normalizedMemorySlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID
  ) {
    return null;
  }
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
    cfg: params.cfg,
  });
  return dreamingConfig.enabled ? DEFAULT_MEMORY_DREAMING_PLUGIN_ID : null;
}

export function resolveAuthorizedDreamingSidecar(params: {
  cfg: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  manifestRegistry: PluginManifestRegistry;
  memorySlot: string | null | undefined;
}): AuthorizedDreamingSidecar | null {
  const engineId = resolveDreamingSidecarEngineId({
    cfg: params.cfg,
    memorySlot: params.memorySlot,
  });
  if (!engineId || !params.normalized.enabled || !params.activationSource.plugins.enabled) {
    return null;
  }
  const selectedMemoryPluginId = normalizeLowercaseStringOrEmpty(params.memorySlot);
  if (!selectedMemoryPluginId || selectedMemoryPluginId === engineId) {
    return null;
  }
  if (
    params.normalized.deny.includes(engineId) ||
    params.activationSource.plugins.deny.includes(engineId) ||
    params.normalized.entries[engineId]?.enabled === false ||
    params.activationSource.plugins.entries[engineId]?.enabled === false
  ) {
    return null;
  }
  const selectedMemoryPlugin = params.manifestRegistry.plugins.find(
    (plugin) => plugin.id === selectedMemoryPluginId,
  );
  const sidecarPlugin = params.manifestRegistry.plugins.find((plugin) => plugin.id === engineId);
  if (
    !selectedMemoryPlugin ||
    !sidecarPlugin ||
    !hasKind(selectedMemoryPlugin.kind, "memory") ||
    !hasKind(sidecarPlugin.kind, "memory")
  ) {
    return null;
  }
  const selectedEnableState = resolveEffectiveEnableState({
    id: selectedMemoryPlugin.id,
    origin: selectedMemoryPlugin.origin,
    config: params.normalized,
    rootConfig: params.cfg,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(selectedMemoryPlugin),
    activationSource: params.activationSource,
  });
  return selectedEnableState.enabled ? { engineId, selectedMemoryPluginId } : null;
}

export function isAuthorizedDreamingSidecarPlugin(params: {
  sidecar: AuthorizedDreamingSidecar | null;
  pluginId: string;
}): boolean {
  return params.sidecar?.engineId === params.pluginId;
}

export function matchesScopedPluginOrDreamingSidecar(params: {
  onlyPluginIdSet: ReadonlySet<string> | null;
  pluginId: string;
  sidecar: AuthorizedDreamingSidecar | null;
}): boolean {
  if (!params.onlyPluginIdSet || params.onlyPluginIdSet.has(params.pluginId)) {
    return true;
  }
  return (
    params.pluginId === params.sidecar?.engineId &&
    params.onlyPluginIdSet.has(params.sidecar.selectedMemoryPluginId)
  );
}

export function createPluginCandidatesFromManifestRegistry(
  manifestRegistry: PluginManifestRegistry,
): PluginCandidate[] {
  return manifestRegistry.plugins.map((record) => {
    const installOwner = resolvePluginManifestInstallOwner(record);
    return recordPluginCandidateInstallOwner(
      {
        idHint: record.id,
        effectivePluginId: record.id,
        rootDir: record.rootDir,
        source: record.source,
        ...(record.setupSource !== undefined ? { setupSource: record.setupSource } : {}),
        origin: record.origin,
        ...(record.workspaceDir !== undefined ? { workspaceDir: record.workspaceDir } : {}),
        ...(record.format !== undefined ? { format: record.format } : {}),
        ...(record.bundleFormat !== undefined ? { bundleFormat: record.bundleFormat } : {}),
        ...(record.packageManifest !== undefined
          ? { packageManifest: record.packageManifest }
          : {}),
      },
      installOwner,
      isPluginManifestInstallOwnerAmbiguous(record),
    );
  });
}

class PluginLoadFailureError extends Error {
  readonly pluginIds: string[];
  readonly registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
    const summary = failedPlugins
      .map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`)
      .join("; ");
    super(`plugin load failed: ${summary}`);
    this.name = "PluginLoadFailureError";
    this.pluginIds = failedPlugins.map((entry) => entry.id);
    this.registry = registry;
  }
}

export function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): Result<Record<string, unknown> | undefined, string[]> {
  const { schema, value } = params;
  if (!schema) {
    return ok(value as Record<string, unknown> | undefined);
  }
  if (isEmptyPluginConfigJsonSchema(schema)) {
    if (
      value === undefined ||
      (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) {
      return ok({});
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return resultError(["<root>: must be object"]);
    }
    return resultError(["<root>: config must be empty"]);
  }
  const result = validateJsonSchemaValue({
    schema,
    cacheKey: params.cacheKey ?? JSON.stringify(schema),
    value: value ?? {},
    applyDefaults: true,
  });
  return result.ok
    ? ok(result.value as Record<string, unknown> | undefined)
    : resultError(result.errors.map((error) => error.text));
}

function isEmptyPluginConfigJsonSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.keys(properties).length > 0
  ) {
    return false;
  }
  const hasConditional = "if" in schema && ("then" in schema || "else" in schema);
  return !(
    "required" in schema ||
    "dependentRequired" in schema ||
    "dependentSchemas" in schema ||
    "dependencies" in schema ||
    "minProperties" in schema ||
    "allOf" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "not" in schema ||
    "patternProperties" in schema ||
    hasConditional
  );
}

export function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]): void {
  diagnostics.push(...append);
}

export function pushPluginValidationError(params: {
  registry: PluginRegistry;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  record: PluginRecord;
  message: string;
}): void {
  params.record.status = "error";
  params.record.error = params.message;
  params.record.failedAt = new Date();
  params.record.failurePhase = "validation";
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: params.record.error,
  });
}

/**
 * Which channels each plugin has ceded to a preferred replacement, keyed by plugin id, plus the
 * claimant each ceded channel went to, keyed by canonical channel id.
 *
 * Displacement and the per-channel winner here are the rule channel schema ownership applies —
 * declared replacement wins, a hand-selected claimant is never displaced — read over the runtime
 * claimant set, where a bare `record.channels` claim serves a channel with or without a schema
 * descriptor. Sharing the rule is what keeps the runtime owner and the validated schema the same
 * plugin by construction; a second registration-time answer would leave the two free to disagree,
 * which is the defect this whole path exists to close.
 *
 * A cede only stands when a claimant it yields to is part of this load. Schema ownership is
 * computed from the whole manifest registry, but a scoped load can contain the ceding plugin
 * without the preferred claimant, and skipping registration then would strand the channel with no
 * runtime owner at all instead of the fallback that served it.
 *
 * Built once per load: the policy resolves preferences from the manifest, the built-in channel
 * registration, and any external catalog, and the map is small — a plugin cedes nothing on a
 * channel unless some claimant declared a preference there.
 */
export function collectCededChannelIdsByPlugin(params: {
  registry: PluginManifestRegistry;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  onlyPluginIdSet: ReadonlySet<string> | null;
  dreamingSidecar: AuthorizedDreamingSidecar | null;
}): {
  cededChannelIdsByPlugin: Map<string, string[]>;
  cededChannelOwners: Map<string, string>;
} {
  const policy = createConfiguredChannelOwnershipPolicy({
    config: params.config,
    sourceConfig: params.sourceConfig,
    registry: params.registry,
    env: params.env,
  });
  const { displaced, winners, isPairSuppressed } = collectRuntimeChannelOwnership(
    params.registry,
    policy,
  );
  const claimantsByChannel = new Map<string, string[]>();
  for (const record of params.registry.plugins) {
    for (const channelId of record.channels) {
      const claimedId = normalizeCededChannelId(channelId);
      const claimants = claimantsByChannel.get(claimedId) ?? [];
      claimantsByChannel.set(claimedId, claimants);
      claimants.push(record.id);
    }
  }
  const cededChannelIdsByPlugin = new Map<string, string[]>();
  const cededChannelOwners = new Map<string, string>();
  for (const [channelId, pluginIds] of displaced) {
    const claimedId = normalizeCededChannelId(channelId);
    // The channel goes to the winner schema ownership computed — the same claimant validation and
    // the Control UI name — and only when this load can register it. The winner is inactive only
    // in the all-claimants-inactive state, where nothing registers and no cede should stand; a
    // winner outside a scoped load must not collect cedes either, or the load strands the channel
    // with no runtime owner instead of the fallback that served it.
    const winner = winners.get(channelId);
    const cededTo =
      winner !== undefined &&
      policy.isPluginActive(winner, claimedId) &&
      matchesScopedPluginOrDreamingSidecar({
        onlyPluginIdSet: params.onlyPluginIdSet,
        pluginId: winner,
        sidecar: params.dreamingSidecar,
      })
        ? winner
        : undefined;
    if (cededTo === undefined) {
      continue;
    }
    cededChannelOwners.set(claimedId, cededTo);
    // Every claimant that is not the winner cedes here, not only the ids the declaration
    // displaced. Independent declarations (A replaces B, C replaces D) leave two active,
    // undisplaced claimants; ceding only the displaced ids let registration order pick between
    // them while schema ownership named its one winner, the exact two-plane split this map exists
    // to close. The displaced ids stay ceded unconditionally because the pair's named target
    // remains an activation candidate, and reading activity alone would hand it back the very
    // channel the declaration takes away. One exemption: a claimant whose declaration with the
    // winner was set aside — a preferOver cycle member or a pair whose target the operator
    // selected — must keep registering, because a set-aside declaration displaces nobody: every
    // member registers and the first registrant keeps the channel. Ceding it would displace the
    // very claimant the suppression exists to protect.
    const cedingPluginIds = new Set(pluginIds);
    for (const claimantId of claimantsByChannel.get(claimedId) ?? []) {
      if (claimantId === cededTo) {
        continue;
      }
      if (
        policy.isPluginActive(claimantId, claimedId) &&
        isPairSuppressed(channelId, cededTo, claimantId)
      ) {
        continue;
      }
      cedingPluginIds.add(claimantId);
    }
    for (const pluginId of cedingPluginIds) {
      const channels = cededChannelIdsByPlugin.get(pluginId) ?? [];
      cededChannelIdsByPlugin.set(pluginId, channels);
      channels.push(channelId);
    }
  }
  return { cededChannelIdsByPlugin, cededChannelOwners };
}

/**
 * Flags every ceded channel that finished the load with no registration at all. Restoring the
 * ceding plugin instead is deliberately off the table: it would hand the channel to the fallback
 * at runtime while the Gateway schema, computed from config and blind to load outcomes, still
 * names the replacement. A rolled-back, quarantined, or unloadable replacement therefore leaves
 * the channel dead, and only this diagnostic says why.
 */
export function pushCededChannelWithoutOwnerDiagnostics(params: {
  registry: PluginRegistry;
  cededChannelOwners: ReadonlyMap<string, string>;
}): void {
  // One dead channel is one diagnostic: a plugin id seen from two origins carries the cede on both
  // records, and several claimants can cede the same channel to one replacement.
  const reported = new Set<string>();
  for (const record of params.registry.plugins) {
    // Activation status is deliberately not a filter. The common shape of this feature disables the
    // fallback — auto-enable turns it off when a replacement supersedes its only channel — so
    // skipping records that never loaded would stay silent in exactly the case the diagnostic
    // exists for. Bundle-format plugins register outside this loader, so their absence from the
    // runtime catalog says nothing about whether the channel is served.
    if (record.format === "bundle") {
      continue;
    }
    for (const channelId of record.cededChannelIds ?? []) {
      const claimedId = normalizeCededChannelId(channelId);
      const registered =
        params.registry.channels.some(
          (entry) => normalizeCededChannelId(entry.plugin.id) === claimedId,
        ) ||
        params.registry.channelSetups.some(
          (entry) => normalizeCededChannelId(entry.plugin.id) === claimedId,
        );
      if (registered) {
        continue;
      }
      const cededTo = params.cededChannelOwners.get(claimedId);
      const cededToRecord = params.registry.plugins.find((entry) => entry.id === cededTo);
      if (cededTo === undefined || cededToRecord?.format === "bundle") {
        continue;
      }
      if (reported.has(claimedId)) {
        continue;
      }
      reported.add(claimedId);
      params.registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `ceded channel has no registered owner: ${channelId} (ceded to ${cededTo})`,
      });
    }
  }
}

/** Builds the common manifest-backed record shape used by runtime and CLI loaders. */
export function createManifestPluginRecord(params: {
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  enabled: boolean;
  activationState: PluginActivationState;
  cededChannelIds?: readonly string[];
}): PluginRecord {
  const { candidate, manifestRecord } = params;
  return createPluginRecord({
    id: manifestRecord.id,
    name: manifestRecord.name ?? manifestRecord.id,
    description: manifestRecord.description,
    packageVersion: manifestRecord.packageVersion,
    version: manifestRecord.version,
    builtWithOpenClawVersion: normalizeOptionalString(
      candidate.packageManifest?.build?.openclawVersion,
    ),
    packageName: manifestRecord.packageName,
    format: manifestRecord.format,
    bundleFormat: manifestRecord.bundleFormat,
    bundleCapabilities: manifestRecord.bundleCapabilities,
    source: candidate.source,
    rootDir: candidate.rootDir,
    origin: candidate.origin,
    workspaceDir: candidate.workspaceDir,
    trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
    enabled: params.enabled,
    compat: collectPluginManifestCompatCodes(manifestRecord),
    activationState: params.activationState,
    syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
    channelIds: manifestRecord.channels,
    ...(params.cededChannelIds?.length ? { cededChannelIds: [...params.cededChannelIds] } : {}),
    providerIds: manifestRecord.providers,
    configSchema: Boolean(manifestRecord.configSchema),
    contracts: manifestRecord.contracts,
    dashboard: manifestRecord.dashboard,
    mcpServers: manifestRecord.mcpServers,
  });
}

export function applyPluginManifestRecordDetails(
  record: PluginRecord,
  manifestRecord: PluginManifestRecord,
): void {
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;
}

export function applyManifestSnapshotMetadata(
  record: PluginRecord,
  manifestRecord: PluginManifestRecord,
): void {
  record.channelIds = [...(manifestRecord.channels ?? [])];
  record.providerIds = [...(manifestRecord.providers ?? [])];
  record.cliBackendIds = [
    ...(manifestRecord.cliBackends ?? []),
    ...(manifestRecord.setup?.cliBackends ?? []),
  ];
  record.commands = (manifestRecord.commandAliases ?? []).map((alias) => alias.name);
}

export function maybeThrowOnPluginLoadError(
  registry: PluginRegistry,
  throwOnLoadError: boolean | undefined,
): void {
  if (throwOnLoadError && registry.plugins.some((entry) => entry.status === "error")) {
    throw new PluginLoadFailureError(registry);
  }
}

export function activatePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string | null,
  runtimeSubagentMode: PluginRuntimeSubagentMode,
  workspaceDir?: string,
): void {
  const activeSnapshot = captureActivePluginRegistrySnapshot();
  const previousHookRegistry = getGlobalPluginRegistry();
  try {
    // Install the complete bundle before hook-runner initialization so hook composition never
    // observes contributions from two loads. Activation failure restores the prior selection.
    stageActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
    initializeGlobalHookRunner(registry);
    activateContextEngineRegistrations(registry);
    commitStagedPluginRegistry(activeSnapshot.activeRegistry, registry);
  } catch (error) {
    restoreActivePluginRegistrySnapshot(activeSnapshot);
    if (previousHookRegistry) {
      initializeGlobalHookRunner(previousHookRegistry);
    } else {
      resetGlobalHookRunner();
    }
    throw error;
  }
}

export function safeRealpathOrResolve(value: string): string {
  return resolveRealpathOrAbsolute(value);
}
