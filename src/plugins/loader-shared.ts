import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
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

/** Builds the common manifest-backed record shape used by runtime and CLI loaders. */
export function createManifestPluginRecord(params: {
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  enabled: boolean;
  activationState: PluginActivationState;
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
    // Direct replacements (reload, CLI loads) complete here — the displaced previous registry
    // retires immediately. Gateway startup's activation instead consumed the bootstrap's
    // off-slot pre-bind attempt, marking the marker defer-to-finalize: the commit installs
    // slot ownership but defers the displaced survivor's retirement to startup-success
    // finalize (see plugins/runtime).
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
