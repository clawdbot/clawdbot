import fs from "node:fs";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadSetupRuntimeChannelCandidate } from "./loader-channel-runtime.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import {
  formatBundledChannelWrongLoaderError,
  type PluginModuleLoader,
  resolvePluginModuleExport,
  runPluginRegisterSync,
} from "./loader-module-runtime.js";
import {
  formatAutoEnabledActivationReason,
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordPluginConfiguredUnavailable,
  recordPluginError,
} from "./loader-records.js";
import { resolvePluginRegistrationPlan } from "./loader-registration-plan.js";
import {
  applyManifestSnapshotMetadata,
  applyPluginManifestRecordDetails,
  type AuthorizedDreamingSidecar,
  createManifestPluginRecord,
  detailPluginStartupTrace,
  isAuthorizedDreamingSidecarPlugin,
  matchesScopedPluginOrDreamingSidecar,
  pushPluginValidationError,
  safeRealpathOrResolve,
  validatePluginConfig,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import {
  resolveCanonicalDistRuntimeSource,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import type { createPluginRegistry, PluginRecord } from "./registry.js";
import {
  clearActiveDegradedPlugin,
  degradedPluginMatchesRoot,
  findActiveDegradedPlugin,
} from "./runtime-degraded-state.js";
import { recordImportedPluginId } from "./runtime.js";
import { hasKind, kindsEqual } from "./slots.js";
import type { OpenClawPluginModule, PluginLogger } from "./types.js";

type PluginRegistryBuilder = ReturnType<typeof createPluginRegistry>;

export type PluginLoadLoopState = {
  seenIds: Map<string, PluginRecord["origin"]>;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
  pluginLoadAttemptCount: number;
};

export function loadRuntimePluginCandidate(params: {
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  context: PluginLoadCacheContext;
  options: PluginLoadOptions;
  onlyPluginIdSet: ReadonlySet<string> | null;
  dreamingSidecar: AuthorizedDreamingSidecar | null;
  validateOnly: boolean;
  registryBuilder: PluginRegistryBuilder;
  loadPluginModule: PluginModuleLoader;
  logger: PluginLogger;
  state: PluginLoadLoopState;
}): void {
  const { candidate, manifestRecord, context, state } = params;
  const { registry } = params.registryBuilder;
  const pluginId = manifestRecord.id;
  const policyId = normalizePluginPolicyId(pluginId);
  // Manifest filtering scopes diagnostics; this final guard also blocks imports
  // and registration outside the requested snapshot.
  if (
    !matchesScopedPluginOrDreamingSidecar({
      onlyPluginIdSet: params.onlyPluginIdSet,
      pluginId,
      sidecar: params.dreamingSidecar,
    })
  ) {
    return;
  }
  const isDreamingSidecar = isAuthorizedDreamingSidecarPlugin({
    sidecar: params.dreamingSidecar,
    pluginId,
  });
  const activationState = isDreamingSidecar
    ? {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "auto" as const,
        reason: `dreaming sidecar for selected memory slot "${params.dreamingSidecar?.selectedMemoryPluginId ?? ""}"`,
      }
    : resolveEffectivePluginActivationState({
        id: pluginId,
        origin: candidate.origin,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
        activationSource: context.activationSource,
        autoEnabledReason: formatAutoEnabledActivationReason(context.autoEnabledReasons[pluginId]),
      });
  const existingOrigin = state.seenIds.get(pluginId);
  if (existingOrigin) {
    const duplicate = createManifestPluginRecord({
      candidate,
      manifestRecord,
      enabled: false,
      activationState,
    });
    duplicate.status = "disabled";
    duplicate.error = `overridden by ${existingOrigin} plugin`;
    markPluginActivationDisabled(duplicate, duplicate.error);
    registry.plugins.push(duplicate);
    return;
  }

  const enableState = isDreamingSidecar
    ? { enabled: true }
    : resolveEffectiveEnableState({
        id: pluginId,
        origin: candidate.origin,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
        activationSource: context.activationSource,
      });
  const entry = context.normalized.entries[policyId];
  const record = createManifestPluginRecord({
    candidate,
    manifestRecord,
    enabled: enableState.enabled,
    activationState,
  });
  applyPluginManifestRecordDetails(record, manifestRecord);
  const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
  const degradedPluginForId = findActiveDegradedPlugin(pluginId);
  const degradedPlugin =
    degradedPluginForId && degradedPluginMatchesRoot(degradedPluginForId, pluginRoot)
      ? degradedPluginForId
      : undefined;
  const clearMismatchedQuarantineAfterLoad =
    enableState.enabled && Boolean(degradedPluginForId) && !degradedPlugin;
  if (enableState.enabled && degradedPlugin) {
    // Startup verification owns this boot-stable quarantine. Return before
    // artifact resolution so no top-level plugin code can execute this boot.
    recordPluginConfiguredUnavailable({
      registry,
      record,
      seenIds: state.seenIds,
      origin: candidate.origin,
      degradedPlugin,
    });
    return;
  }
  const localSetupBasePolicyBlock = resolveManifestOwnerBasePolicyBlock({
    plugin: { id: pluginId },
    normalizedConfig: context.normalized,
  });
  const trustedLocalScopedChannelSetupImport =
    localSetupBasePolicyBlock === null &&
    (hasExplicitManifestOwnerTrust({
      plugin: { id: pluginId },
      normalizedConfig: context.normalized,
    }) ||
      (candidate.origin === "workspace" && activationState.source === "auto"));
  // Setup-only loads bypass normal activation, so reapply trust before importing
  // non-bundled local plugins.
  const blockUntrustedLocalScopedChannelSetupImport =
    context.includeSetupOnlyChannelPlugins &&
    !params.validateOnly &&
    Boolean(params.onlyPluginIdSet) &&
    manifestRecord.channels.length > 0 &&
    candidate.origin !== "bundled" &&
    !trustedLocalScopedChannelSetupImport;
  const pushPluginLoadError = (message: string) =>
    pushPluginValidationError({
      registry,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      record,
      message,
    });
  if (blockUntrustedLocalScopedChannelSetupImport) {
    record.status = "disabled";
    record.error =
      activationState.reason ??
      enableState.reason ??
      "local plugin requires explicit trust for setup";
    markPluginActivationDisabled(record, record.error);
    // Do not claim seenIds: a different-id trusted fallback may still load later.
    registry.plugins.push(record);
    return;
  }

  const runtimeCandidateEntry = resolvePluginRuntimeArtifact({
    pluginId,
    entryKind: "runtime",
    source: candidate.source,
    rootDir: pluginRoot,
    origin: candidate.origin,
    preferBuiltPluginArtifacts: context.preferBuiltPluginArtifacts,
    packageManifest: candidate.packageManifest,
  });
  const runtimeSetupEntry = manifestRecord.setupSource
    ? resolvePluginRuntimeArtifact({
        pluginId,
        entryKind: "setup",
        source: manifestRecord.setupSource,
        rootDir: pluginRoot,
        origin: candidate.origin,
        preferBuiltPluginArtifacts: context.preferBuiltPluginArtifacts,
        packageManifest: candidate.packageManifest,
      })
    : undefined;
  const scopedSetupOnlyChannelPluginRequested =
    context.includeSetupOnlyChannelPlugins &&
    !params.validateOnly &&
    Boolean(params.onlyPluginIdSet) &&
    manifestRecord.channels.length > 0 &&
    (!enableState.enabled || context.forceSetupOnlyChannelPlugins);
  const canLoadScopedSetupOnlyChannelPlugin =
    scopedSetupOnlyChannelPluginRequested &&
    (candidate.origin !== "workspace" || enableState.enabled) &&
    (!context.requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource));
  const registrationPlan = resolvePluginRegistrationPlan({
    canLoadScopedSetupOnlyChannelPlugin,
    scopedSetupOnlyChannelPluginRequested,
    requireSetupEntryForSetupOnlyChannelPlugins:
      context.requireSetupEntryForSetupOnlyChannelPlugins,
    enableStateEnabled: enableState.enabled,
    shouldLoadModules: context.shouldLoadModules,
    validateOnly: params.validateOnly,
    shouldActivate: context.shouldActivate,
    manifestRecord,
    cfg: context.cfg,
    env: context.env,
    preferSetupRuntimeForChannelPlugins: context.forceFullRuntimeForChannelPlugins
      ? false
      : context.preferSetupRuntimeForChannelPlugins,
    forceFullRuntimeForChannelPlugins: context.forceFullRuntimeForChannelPlugins,
    toolDiscovery: params.options.toolDiscovery === true,
  });
  if (!registrationPlan) {
    record.status = "disabled";
    record.error = enableState.reason;
    markPluginActivationDisabled(record, enableState.reason);
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  if (!enableState.enabled) {
    record.status = "disabled";
    record.error = enableState.reason;
    markPluginActivationDisabled(record, enableState.reason);
  }

  if (record.format === "bundle") {
    recordBundleDiagnostics({ record, registry });
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  const memorySlot = context.normalized.slots.memory;
  if (
    registrationPlan.runRuntimeCapabilityPolicy &&
    candidate.origin === "bundled" &&
    hasKind(manifestRecord.kind, "memory") &&
    !isDreamingSidecar
  ) {
    // Skip bundled memory modules already disabled by slot policy. The authorized
    // dreaming sidecar remains loadable alongside the selected memory plugin.
    const earlyMemoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: manifestRecord.kind,
      slot: memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!earlyMemoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = earlyMemoryDecision.reason;
      markPluginActivationDisabled(record, earlyMemoryDecision.reason);
      registry.plugins.push(record);
      state.seenIds.set(pluginId, candidate.origin);
      return;
    }
  }
  if (!manifestRecord.configSchema) {
    pushPluginLoadError("missing config schema");
    return;
  }
  if (!context.shouldLoadModules && registrationPlan.runRuntimeCapabilityPolicy) {
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled && !isDreamingSidecar) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      markPluginActivationDisabled(record, memoryDecision.reason);
      registry.plugins.push(record);
      state.seenIds.set(pluginId, candidate.origin);
      return;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      state.selectedMemoryPluginId = record.id;
      state.memorySlotMatched = true;
      record.memorySlotSelected = true;
    }
  }
  const validatedConfig = validatePluginConfig({
    schema: manifestRecord.configSchema,
    cacheKey: manifestRecord.schemaCacheKey,
    value: entry?.config,
  });
  if (!validatedConfig.ok) {
    params.logger.error(
      `[plugins] ${record.id} invalid config: ${validatedConfig.error.join(", ")}`,
    );
    pushPluginLoadError(`invalid config: ${validatedConfig.error.join(", ")}`);
    return;
  }
  if (!context.shouldLoadModules) {
    applyManifestSnapshotMetadata(record, manifestRecord);
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }

  const loadEntry =
    registrationPlan.loadSetupEntry && runtimeSetupEntry
      ? runtimeSetupEntry
      : runtimeCandidateEntry;
  const moduleLoadSource = resolveCanonicalDistRuntimeSource(loadEntry.source);
  const moduleRoot = resolveCanonicalDistRuntimeSource(loadEntry.rootDir);
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: candidate.origin,
    rootDir: candidate.rootDir,
    env: context.env,
  });
  const opened = openRootFileSync({
    absolutePath: moduleLoadSource,
    rootPath: moduleRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
    return;
  }
  const safeSource = opened.path;
  fs.closeSync(opened.fd);

  let mod: OpenClawPluginModule | null = null;
  let moduleLoadMs: number;
  let moduleLoadFailed = false;
  const beforeModuleLoad = performance.now();
  try {
    // Top-level code may execute before module evaluation throws, so record the
    // import attempt before invoking the loader.
    recordImportedPluginId(record.id);
    state.pluginLoadAttemptCount++;
    params.logger.debug?.(`[plugins] loading ${record.id} from ${safeSource}`);
    mod = withProfile(
      { pluginId: record.id, source: safeSource },
      registrationPlan.mode,
      () => params.loadPluginModule(safeSource) as OpenClawPluginModule,
    );
  } catch (error) {
    recordPluginError({
      logger: params.logger,
      registry,
      record,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      phase: "load",
      error,
      logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
      diagnosticMessagePrefix: "failed to load plugin: ",
    });
    moduleLoadFailed = true;
    return;
  } finally {
    moduleLoadMs = performance.now() - beforeModuleLoad;
    detailPluginStartupTrace(params.options.startupTrace, record.id, [
      ["loadMs", moduleLoadMs],
      ["loadFailedCount", moduleLoadFailed ? 1 : 0],
    ]);
  }
  if (
    loadSetupRuntimeChannelCandidate({
      mod,
      manifestRecord,
      record,
      registrationPlan,
      runtimeCandidateEntry,
      safeSource,
      rejectHardlinks,
      loadPluginModule: params.loadPluginModule,
      registryBuilder: params.registryBuilder,
      cfg: context.cfg,
      entry,
      env: context.env,
      preferSetupRuntimeForChannelPlugins: context.preferSetupRuntimeForChannelPlugins,
      seenIds: state.seenIds,
      candidateOrigin: candidate.origin,
      logger: params.logger,
      pushPluginLoadError,
    })
  ) {
    return;
  }

  const resolved = resolvePluginModuleExport(mod);
  const { definition, register } = resolved;
  if (definition?.id && definition.id !== record.id) {
    pushPluginLoadError(
      `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
    );
    return;
  }
  record.name = definition?.name ?? record.name;
  record.description = definition?.description ?? record.description;
  record.version = definition?.version ?? record.version;
  const manifestKind = record.kind;
  const exportKind = definition?.kind;
  if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
    registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
    });
  }
  record.kind = definition?.kind ?? record.kind;
  if (hasKind(record.kind, "memory") && memorySlot === record.id) {
    state.memorySlotMatched = true;
  }
  if (registrationPlan.runRuntimeCapabilityPolicy && !isDreamingSidecar) {
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      markPluginActivationDisabled(record, memoryDecision.reason);
      registry.plugins.push(record);
      state.seenIds.set(pluginId, candidate.origin);
      return;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      state.selectedMemoryPluginId = record.id;
      record.memorySlotSelected = true;
    }
  }
  if (registrationPlan.runFullActivationOnlyRegistrations) {
    if (definition?.reload) {
      params.registryBuilder.registerReload(record, definition.reload);
    }
    for (const nodeHostCommand of definition?.nodeHostCommands ?? []) {
      params.registryBuilder.registerNodeHostCommand(record, nodeHostCommand);
    }
    for (const collector of definition?.securityAuditCollectors ?? []) {
      params.registryBuilder.registerSecurityAuditCollector(record, collector);
    }
  }
  if (params.validateOnly) {
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  if (typeof register !== "function") {
    const wrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
    if (wrongLoaderError) {
      params.logger.error(
        `[plugins] ${record.id} ${wrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`,
      );
      pushPluginLoadError(wrongLoaderError);
    } else {
      params.logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError(formatMissingPluginRegisterError(mod, context.env));
    }
    return;
  }
  const api = params.registryBuilder.createApi(record, {
    config: context.cfg,
    pluginConfig: validatedConfig.value,
    hookPolicy: entry?.hooks,
    registrationMode: registrationPlan.mode,
  });
  const transaction = createPluginRegistrationTransaction({
    registry,
    rollbackGlobalSideEffects: () =>
      params.registryBuilder.rollbackPluginGlobalSideEffects(record.id),
  });
  const beforeRegister = performance.now();
  let registerFailed = false;
  try {
    withProfile(
      { pluginId: record.id, source: record.source },
      `${registrationPlan.mode}:register`,
      () => runPluginRegisterSync(register, api),
    );
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    transaction.commit({ activate: context.shouldActivate });
    if (clearMismatchedQuarantineAfterLoad) {
      // Plugin ids can intentionally shadow an installed source via load.paths.
      // Clear stale install state only after the selected override registers.
      clearActiveDegradedPlugin(pluginId);
    }
  } catch (error) {
    transaction.rollback();
    recordPluginError({
      logger: params.logger,
      registry,
      record,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      phase: "register",
      error,
      logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
      diagnosticMessagePrefix: "plugin failed during register: ",
    });
    registerFailed = true;
  } finally {
    const registerMs = performance.now() - beforeRegister;
    detailPluginStartupTrace(params.options.startupTrace, record.id, [
      ["registerMs", registerMs],
      ["loadAndRegisterMs", moduleLoadMs + registerMs],
      ["registerFailedCount", registerFailed ? 1 : 0],
    ]);
  }
}

function recordBundleDiagnostics(params: {
  record: PluginRecord;
  registry: PluginRegistryBuilder["registry"];
}): void {
  const unsupportedCapabilities = (params.record.bundleCapabilities ?? []).filter(
    (capability) =>
      capability !== "skills" &&
      capability !== "mcpServers" &&
      capability !== "settings" &&
      !(
        (capability === "commands" ||
          capability === "agents" ||
          capability === "outputStyles" ||
          capability === "lspServers") &&
        (params.record.bundleFormat === "claude" || params.record.bundleFormat === "cursor")
      ) &&
      !(
        capability === "hooks" &&
        (params.record.bundleFormat === "codex" || params.record.bundleFormat === "claude")
      ),
  );
  for (const capability of unsupportedCapabilities) {
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: params.record.id,
      source: params.record.source,
      message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
    });
  }
  if (
    params.record.enabled &&
    params.record.rootDir &&
    params.record.bundleFormat &&
    (params.record.bundleCapabilities ?? []).includes("mcpServers")
  ) {
    const runtimeSupport = inspectBundleMcpRuntimeSupport({
      pluginId: params.record.id,
      rootDir: params.record.rootDir,
      bundleFormat: params.record.bundleFormat,
    });
    for (const message of runtimeSupport.diagnostics) {
      params.registry.diagnostics.push({
        level: "warn",
        pluginId: params.record.id,
        source: params.record.source,
        message,
      });
    }
    if (runtimeSupport.unsupportedServerNames.length > 0) {
      params.registry.diagnostics.push({
        level: "warn",
        pluginId: params.record.id,
        source: params.record.source,
        message:
          "bundle MCP servers use unsupported transports or incomplete configs " +
          `(stdio only today): ${runtimeSupport.unsupportedServerNames.join(", ")}`,
      });
    }
  }
  params.registry.plugins.push(params.record);
}
