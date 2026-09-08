import fs from "node:fs";
import { describeRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { isBundleCapabilitySupported } from "./bundle-capability-support.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { capabilityCatalogFamilies, resolvePluginCapabilityCatalog } from "./capability-catalog.js";
import { resolveMemorySlotDecision } from "./config-state.js";
import {
  PluginDashboardDeclarationError,
  registerPluginDashboardCapabilities,
} from "./dashboard-capabilities.js";
import type { PluginCandidate } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadSetupRuntimeChannelCandidate } from "./loader-channel-runtime.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import {
  formatBundledChannelWrongLoaderError,
  type PluginModuleLoader,
  resolvePluginModuleExport,
  runPluginRegisterSyncInRegistry,
} from "./loader-module-runtime.js";
import {
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordPluginConfiguredUnavailable,
  recordPluginError,
} from "./loader-records.js";
import { resolvePluginRegistrationPlan } from "./loader-registration-plan.js";
import {
  applyManifestSnapshotMetadata,
  type AuthorizedDreamingSidecar,
  detailPluginStartupTrace,
  preparePluginLoadRecord,
  safeRealpathOrResolve,
  validatePluginConfig,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolveExternalPluginRuntimeDependencyRepairHint } from "./official-external-plugin-repair-hints.js";
import { withProfile } from "./plugin-load-profile.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";
import { resolvePluginRuntimeArtifact } from "./plugin-runtime-artifact-resolution.js";
import {
  bindPluginRuntimeArtifactSelection,
  resolvePluginRuntimeExecutionArtifact,
  prefersBuiltPluginArtifacts,
} from "./plugin-runtime-artifact-selection.js";
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
  const prepared = preparePluginLoadRecord({
    candidate,
    manifestRecord,
    context,
    onlyPluginIdSet: params.onlyPluginIdSet,
    dreamingSidecar: params.dreamingSidecar,
    registry,
    seenIds: state.seenIds,
  });
  if (!prepared) {
    return;
  }
  const { pluginId, policyId, isDreamingSidecar, activationState, enableState, entry, record } =
    prepared;
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
    recordPluginError({
      registry,
      seenIds: state.seenIds,
      record,
      phase: "validation",
      error: message,
    });
  const missingDependencyHint = resolveExternalPluginRuntimeDependencyRepairHint({
    pluginId,
    packageName: candidate.packageName,
    packageBuild: candidate.packageManifest?.build,
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

  const preferBuiltPluginArtifacts = prefersBuiltPluginArtifacts(
    context.artifactPreference,
    candidate.origin,
  );
  const artifactParams = {
    pluginId,
    rootDir: pluginRoot,
    origin: candidate.origin,
    preferBuiltPluginArtifacts,
    sourcePreferred: manifestRecord.sourcePreferred,
    packageManifest: candidate.packageManifest,
    registry,
  };
  const runtimeCandidateEntry = resolvePluginRuntimeArtifact({
    ...artifactParams,
    entryKind: "runtime",
    source: candidate.source,
  });
  const runtimeSetupEntry = manifestRecord.setupSource
    ? resolvePluginRuntimeArtifact({
        ...artifactParams,
        entryKind: "setup",
        source: manifestRecord.setupSource,
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
    (candidate.origin !== "workspace" || enableState.enabled);
  const registrationPlan = resolvePluginRegistrationPlan({
    canLoadScopedSetupOnlyChannelPlugin,
    enableStateEnabled: enableState.enabled,
    shouldLoadModules: context.shouldLoadModules,
    validateOnly: params.validateOnly,
    shouldActivate: context.shouldActivate,
    manifestRecord,
    cfg: context.cfg,
    env: context.env,
    channelPluginLoadIntent: context.channelPluginLoadIntent,
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
    origin: candidate.origin,
    schema: manifestRecord.configSchema,
    cacheKey: manifestRecord.schemaCacheKey,
    value: entry?.config,
    sourceValue: manifestRecord.configContracts?.secretInputs
      ? context.activationSource.plugins.entries[policyId]?.config
      : undefined,
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

  const catalogRequest = params.options.capabilityCatalog;
  if (catalogRequest && manifestRecord.capabilityCatalogSource !== undefined) {
    try {
      if (!manifestRecord.capabilityCatalogSource) {
        throw new Error("entry must resolve inside the selected plugin root");
      }
      const artifact = resolvePluginRuntimeArtifact({
        ...artifactParams,
        entryKind: "capability-catalog",
        source: manifestRecord.capabilityCatalogSource,
      });
      const { source, modulePath } = preparePluginModule({
        modulePath: artifact.source,
        boundaryRoot: artifact.rootDir,
        boundaryLabel: "plugin root",
        rejectHardlinks: shouldRejectHardlinkedPluginFiles({
          origin: candidate.origin,
          rootDir: candidate.rootDir,
          env: context.env,
        }),
        surfaceLabel: `${pluginId} capabilityCatalogEntry`,
      });
      if (source.capabilityCatalog?.context !== catalogRequest.context) {
        source.capabilityCatalog = {
          context: catalogRequest.context,
          value: resolvePluginCapabilityCatalog(
            params.loadPluginModule(modulePath),
            catalogRequest.context,
          ),
        };
      }
      const catalog = source.capabilityCatalog.value;
      if (Object.hasOwn(catalog, catalogRequest.family)) {
        const catalogApi = params.registryBuilder.createApi(record, {
          config: context.cfg,
          pluginConfig: validatedConfig.value,
          hookPolicy: entry?.hooks,
          registrationMode: registrationPlan.mode,
        });
        runPluginRegisterSyncInRegistry(
          (registration) => {
            for (const provider of catalog.speechProviders ?? []) {
              registration.registerSpeechProvider(provider);
            }
            for (const provider of catalog.realtimeTranscriptionProviders ?? []) {
              registration.registerRealtimeTranscriptionProvider(provider);
            }
            for (const provider of catalog.realtimeVoiceProviders ?? []) {
              registration.registerRealtimeVoiceProvider(provider);
            }
          },
          catalogApi,
          registry,
          record.id,
        );
        // Descriptor coverage must never satisfy full-runtime containment checks.
        record.imported = false;
        record.capabilityCatalog = capabilityCatalogFamilies.filter((key) =>
          Object.hasOwn(catalog, key),
        );
        registry.plugins.push(record);
        state.seenIds.set(pluginId, candidate.origin);
        return;
      }
    } catch (error) {
      params.registryBuilder.rollbackPluginGlobalSideEffects(record.id, record);
      throw new Error(
        `Plugin ${pluginId} capabilityCatalogEntry failed: ${String(error)}. Repair the declared entry in ${manifestRecord.manifestPath}.`,
        { cause: error },
      );
    }
    // Shipped register()-only plugins and families omitted by a catalog keep runtime discovery.
  }

  const loadEntry = resolvePluginRuntimeExecutionArtifact(
    registrationPlan.loadSetupEntry && runtimeSetupEntry
      ? runtimeSetupEntry
      : runtimeCandidateEntry,
  );
  // Setup runtime can register a channel without importing the main entry.
  // Retain the setup source that actually ran, rather than unused declarations.
  const artifactSelection = bindPluginRuntimeArtifactSelection(record, {
    ...artifactParams,
    runtimeEntry: resolvePluginRuntimeExecutionArtifact(runtimeCandidateEntry),
    setupEntry: registrationPlan.loadSetupEntry ? loadEntry : undefined,
  });
  const moduleLoadSource = loadEntry.source;
  const moduleRoot = loadEntry.rootDir;
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
    pushPluginLoadError(
      describeRootFileOpenFailure({
        failure: opened,
        subject: "plugin entry path",
        boundaryLabel: "plugin root",
        filePath: moduleLoadSource,
      }),
    );
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
      phase: "load",
      error,
      logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
      diagnosticMessagePrefix: "failed to load plugin: ",
      missingDependencyHint,
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
      seenIds: state.seenIds,
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
  // Node-host commands register in every load mode: the node host resolves its
  // registry without activation (loadPluginRegistryHandle), and each command is
  // already availability-gated per invocation. Gating them on full activation
  // silently strips static registrations like browser.proxy from headless nodes.
  for (const nodeHostCommand of definition?.nodeHostCommands ?? []) {
    params.registryBuilder.registerNodeHostCommand(record, nodeHostCommand);
  }
  if (registrationPlan.runFullActivationOnlyRegistrations) {
    if (definition?.reload) {
      params.registryBuilder.registerReload(record, definition.reload);
    }
    for (const collector of definition?.securityAuditCollectors ?? []) {
      params.registryBuilder.registerSecurityAuditCollector(record, collector);
    }
  }
  const api = params.registryBuilder.createApi(record, {
    config: context.cfg,
    pluginConfig: validatedConfig.value,
    hookPolicy: entry?.hooks,
    registrationMode: registrationPlan.mode,
  });
  const beforeRegister = performance.now();
  let registerFailed = false;
  try {
    withProfile(
      { pluginId: record.id, source: record.source },
      `${registrationPlan.mode}:register`,
      () => runPluginRegisterSyncInRegistry(register, api, registry, record.id),
    );
    // Dashboard entries stay inside the same registry snapshot as their RPC handlers.
    // Non-activating snapshots are private until cached activation; rollback restores both.
    if (registrationPlan.runRuntimeCapabilityPolicy) {
      registerPluginDashboardCapabilities({ record, registry });
      // Publish completion only after the capability-enabled register pass succeeds.
      artifactSelection.runtimeRegistrationComplete = true;
    }
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    if (clearMismatchedQuarantineAfterLoad) {
      // Plugin ids can intentionally shadow an installed source via load.paths.
      // Clear stale install state only after the selected override registers.
      clearActiveDegradedPlugin(pluginId);
    }
  } catch (error) {
    params.registryBuilder.rollbackPluginGlobalSideEffects(record.id, record);
    recordPluginError({
      logger: params.logger,
      registry,
      record,
      seenIds: state.seenIds,
      phase: "register",
      error,
      logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
      diagnosticMessagePrefix: "plugin failed during register: ",
      missingDependencyHint,
      ...(error instanceof PluginDashboardDeclarationError
        ? { diagnosticCode: "dashboard-declaration-invalid" }
        : {}),
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
      !params.record.bundleFormat ||
      !isBundleCapabilitySupported(params.record.bundleFormat, capability),
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
          `(${runtimeSupport.unsupportedServerNames.join(", ")})`,
      });
    }
  }
  params.registry.plugins.push(params.record);
}
