import fs from "node:fs";
import path from "node:path";
import { describeRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { capabilityCatalogFamilies, resolvePluginCapabilityCatalog } from "./capability-catalog.js";
import {
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import {
  PluginDashboardDeclarationError,
  registerPluginDashboardCapabilities,
} from "./dashboard-capabilities.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadSetupRuntimeChannelCandidate } from "./loader-channel-runtime.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import {
  formatBundledChannelWrongLoaderError,
  type PluginModuleLoader,
  runPluginRegisterSyncInRegistry,
} from "./loader-module-runtime.js";
import {
  formatAutoEnabledActivationReason,
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordBundleDiagnostics,
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
  validatePluginConfig,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginModuleExport } from "./module-export.js";
import { resolveExternalPluginRuntimeDependencyRepairHint } from "./official-external-plugin-repair-hints.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { withProfile } from "./plugin-load-profile.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import {
  resolveCanonicalDistRuntimeSource,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { prefersBuiltPluginArtifacts } from "./plugin-runtime-artifact-selection.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
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
  const cliMetadata = params.options.mode === "cli-metadata";
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
        channelIds: manifestRecord.channels,
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
    markPluginActivationDisabled(duplicate, `overridden by ${existingOrigin} plugin`);
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
        channelIds: manifestRecord.channels,
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
  const pluginRoot = resolveRealpathOrAbsolute(candidate.rootDir);
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
    !cliMetadata &&
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
    markPluginActivationDisabled(
      record,
      activationState.reason ??
        enableState.reason ??
        "local plugin requires explicit trust for setup",
    );
    // Do not claim seenIds: a different-id trusted fallback may still load later.
    registry.plugins.push(record);
    return;
  }

  const preferBuiltPluginArtifacts = prefersBuiltPluginArtifacts(
    context.artifactPreference,
    candidate.origin,
  );
  const runtimeCandidateEntry = cliMetadata
    ? { source: candidate.source, rootDir: pluginRoot }
    : resolvePluginRuntimeArtifact({
        pluginId,
        entryKind: "runtime",
        source: candidate.source,
        rootDir: pluginRoot,
        origin: candidate.origin,
        preferBuiltPluginArtifacts,
        sourcePreferred: manifestRecord.sourcePreferred,
        packageManifest: candidate.packageManifest,
        registry,
      });
  const runtimeSetupEntry =
    !cliMetadata && manifestRecord.setupSource
      ? resolvePluginRuntimeArtifact({
          pluginId,
          entryKind: "setup",
          source: manifestRecord.setupSource,
          rootDir: pluginRoot,
          origin: candidate.origin,
          preferBuiltPluginArtifacts,
          sourcePreferred: manifestRecord.sourcePreferred,
          packageManifest: candidate.packageManifest,
          registry,
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
    shouldActivate: params.options.runtimeSideEffects ?? context.shouldActivate,
    manifestRecord,
    cfg: context.cfg,
    env: context.env,
    channelPluginLoadIntent: context.channelPluginLoadIntent,
    toolDiscovery: params.options.toolDiscovery === true,
    cliMetadata,
  });
  if (!registrationPlan) {
    markPluginActivationDisabled(record, enableState.reason);
    registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  if (!enableState.enabled) {
    markPluginActivationDisabled(record, enableState.reason);
  }

  if (record.format === "bundle") {
    if (cliMetadata) {
      registry.plugins.push(record);
    } else {
      recordBundleDiagnostics({ record, registry, inspectMcp: inspectBundleMcpRuntimeSupport });
    }
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
        pluginId,
        entryKind: "capability-catalog",
        source: manifestRecord.capabilityCatalogSource,
        rootDir: pluginRoot,
        origin: candidate.origin,
        preferBuiltPluginArtifacts,
        sourcePreferred: manifestRecord.sourcePreferred,
        packageManifest: candidate.packageManifest,
        registry,
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
            getPluginSetupModuleLoader(
              manifestRecord,
              modulePath,
              artifact.rootDir,
              params.loadPluginModule,
            )(modulePath),
            catalogRequest.context,
          ),
        };
      }
      const catalog = source.capabilityCatalog.value;
      if (Object.hasOwn(catalog, catalogRequest.family)) {
        // Catalog callables belong to their shared inventory, not a per-family runtime instance.
        for (const provider of catalog.speechProviders ?? []) {
          params.registryBuilder.registerSpeechProvider(record, provider);
        }
        for (const provider of catalog.realtimeTranscriptionProviders ?? []) {
          params.registryBuilder.registerRealtimeTranscriptionProvider(record, provider);
        }
        for (const provider of catalog.realtimeVoiceProviders ?? []) {
          params.registryBuilder.registerRealtimeVoiceProvider(record, provider);
        }
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

  let loadEntry =
    registrationPlan.loadSetupEntry && runtimeSetupEntry
      ? runtimeSetupEntry
      : runtimeCandidateEntry;
  if (cliMetadata) {
    const source = resolveCliMetadataEntrySource(candidate.rootDir, candidate.source);
    // Bundled metadata must never initialize a heavy runtime entry just to render CLI help.
    if (!source && candidate.origin === "bundled") {
      registry.plugins.push(record);
      state.seenIds.set(pluginId, candidate.origin);
      return;
    }
    loadEntry = { source: source ?? candidate.source, rootDir: pluginRoot };
  }
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

  let moduleLoadMs = 0;
  let beforeRegister: number | undefined;
  let failurePhase: "load" | "register" = "load";
  let failed = false;
  const beforeModuleLoad = performance.now();
  try {
    // Top-level code may execute before module evaluation throws, so record the
    // import attempt before invoking the loader.
    if (!cliMetadata) {
      recordImportedPluginId(record.id);
    }
    state.pluginLoadAttemptCount++;
    params.logger.debug?.(`[plugins] loading ${record.id} from ${safeSource}`);
    const loadPluginModule = (source: string) =>
      params.loadPluginModule(source, {
        record,
        rootDir: moduleRoot,
        registry,
        standalone: manifestRecord.manifestPath === candidate.source,
      });
    const mod = withProfile(
      { pluginId: record.id, source: safeSource },
      registrationPlan.mode,
      () => loadPluginModule(safeSource) as OpenClawPluginModule,
    );
    moduleLoadMs = performance.now() - beforeModuleLoad;
    const instance = getPluginInstance(record);
    const loadSetupCandidate = () =>
      loadSetupRuntimeChannelCandidate({
        mod,
        manifestRecord,
        record,
        registrationPlan,
        runtimeCandidateEntry,
        safeSource,
        rejectHardlinks,
        loadPluginModule,
        registryBuilder: params.registryBuilder,
        cfg: context.cfg,
        entry,
        seenIds: state.seenIds,
        logger: params.logger,
        pushPluginLoadError,
      });
    if (instance ? instance.run(loadSetupCandidate) : loadSetupCandidate()) {
      return;
    }

    const { definition, register } = resolvePluginModuleExport(mod);
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
    beforeRegister = performance.now();
    failurePhase = "register";
    const registerPlugin = () => {
      const ownedDefinition = instance?.wrap(definition) ?? definition;
      // Headless nodes also use non-activating registries; their commands remain available.
      if (!cliMetadata) {
        for (const command of ownedDefinition?.nodeHostCommands ?? []) {
          params.registryBuilder.registerNodeHostCommand(record, command);
        }
      }
      if (registrationPlan.runFullActivationOnlyRegistrations) {
        if (ownedDefinition?.reload) {
          params.registryBuilder.registerReload(record, ownedDefinition.reload);
        }
        for (const collector of ownedDefinition?.securityAuditCollectors ?? []) {
          params.registryBuilder.registerSecurityAuditCollector(record, collector);
        }
      }
      const api = params.registryBuilder.createApi(record, {
        config: context.cfg,
        pluginConfig: validatedConfig.value,
        hookPolicy: entry?.hooks,
        registrationMode: registrationPlan.mode,
      });
      return withProfile(
        { pluginId: record.id, source: record.source },
        `${registrationPlan.mode}:register`,
        () => runPluginRegisterSyncInRegistry(register, api, registry, record.id),
      );
    };
    if (instance) {
      instance.run(registerPlugin);
    } else {
      registerPlugin();
    }
    // Dashboard entries stay inside the same registry snapshot as their RPC handlers.
    // Non-activating snapshots are private until cached activation; rollback restores both.
    if (!cliMetadata && registrationPlan.runRuntimeCapabilityPolicy) {
      registerPluginDashboardCapabilities({ record, registry });
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
      phase: failurePhase,
      error,
      logPrefix: `[plugins] ${record.id} failed during ${failurePhase} from ${record.source}: `,
      diagnosticMessagePrefix: `plugin failed during ${failurePhase}: `,
      missingDependencyHint,
      ...(error instanceof PluginDashboardDeclarationError
        ? { diagnosticCode: "dashboard-declaration-invalid" }
        : {}),
    });
    failed = true;
  } finally {
    const elapsed = performance.now() - beforeModuleLoad;
    const registerMs =
      beforeRegister === undefined ? undefined : performance.now() - beforeRegister;
    detailPluginStartupTrace(params.options.startupTrace, record.id, [
      ["loadMs", moduleLoadMs || elapsed],
      ["loadFailedCount", failed && failurePhase === "load" ? 1 : 0],
      ...(registerMs === undefined
        ? []
        : ([
            ["registerMs", registerMs],
            ["loadAndRegisterMs", elapsed],
            ["registerFailedCount", failed ? 1 : 0],
          ] as const)),
    ]);
  }
}

function resolveCliMetadataEntrySource(rootDir: string, source: string): string | null {
  for (const directory of new Set([rootDir, path.dirname(source)])) {
    for (const extension of [".ts", ".js", ".mjs", ".cjs"]) {
      const candidate = path.join(directory, `cli-metadata${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
