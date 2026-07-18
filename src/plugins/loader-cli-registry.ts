import fs from "node:fs";
import path from "node:path";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi } from "./api-builder.js";
import {
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { resolvePluginLoadDiscovery } from "./loader-discovery.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import {
  createPluginModuleLoader,
  formatBundledChannelWrongLoaderError,
  resolvePluginModuleExport,
  runPluginRegisterSync,
} from "./loader-module-runtime.js";
import {
  formatAutoEnabledActivationReason,
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordPluginError,
} from "./loader-records.js";
import {
  applyPluginManifestRecordDetails,
  createManifestPluginRecord,
  createPluginLoaderLogger,
  isAuthorizedDreamingSidecarPlugin,
  matchesScopedPluginOrDreamingSidecar,
  pushPluginValidationError,
  resolveAuthorizedDreamingSidecar,
  safeRealpathOrResolve,
  validatePluginConfig,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { withProfile } from "./plugin-load-profile.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { hasKind, kindsEqual } from "./slots.js";
import type { OpenClawPluginModule } from "./types.js";

const CLI_METADATA_ENTRY_BASENAMES = [
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
] as const;

export async function loadOpenClawPluginCliRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const context = resolvePluginLoadCacheContext({ ...options, activate: false });
  const logger = options.logger ?? createPluginLoaderLogger();
  const onlyPluginIdSet = createPluginIdScopeSet(context.onlyPluginIds);
  const loadPluginModule = createPluginModuleLoader({
    devSourceRoot: context.devSourceRoot,
    pluginSdkResolution: options.pluginSdkResolution,
  });
  const { registry, registerCli } = createPluginRegistry({
    logger,
    runtime: {} as PluginRuntime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    ...(options.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: options.coreGatewayMethodNames,
    }),
    activateGlobalSideEffects: false,
  });
  const { manifestRegistry, orderedCandidates, manifestByRoot } = resolvePluginLoadDiscovery({
    options,
    context,
    diagnostics: registry.diagnostics,
    logger,
    onlyPluginIdSet,
    emitWarning: false,
    warningCacheKey: `${context.cacheKey}::cli-metadata`,
  });
  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = context.normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const dreamingSidecar = resolveAuthorizedDreamingSidecar({
    cfg: context.cfg,
    normalized: context.normalized,
    activationSource: context.activationSource,
    manifestRegistry,
    memorySlot,
  });

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const policyId = normalizePluginPolicyId(pluginId);
    if (
      !matchesScopedPluginOrDreamingSidecar({
        onlyPluginIdSet,
        pluginId,
        sidecar: dreamingSidecar,
      })
    ) {
      continue;
    }
    const isDreamingSidecar = isAuthorizedDreamingSidecarPlugin({
      sidecar: dreamingSidecar,
      pluginId,
    });
    const activationState = isDreamingSidecar
      ? {
          enabled: true,
          activated: true,
          explicitlyEnabled: false,
          source: "auto" as const,
          reason: `dreaming sidecar for selected memory slot "${dreamingSidecar?.selectedMemoryPluginId ?? ""}"`,
        }
      : resolveEffectivePluginActivationState({
          id: pluginId,
          origin: candidate.origin,
          config: context.normalized,
          rootConfig: context.cfg,
          enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
          activationSource: context.activationSource,
          autoEnabledReason: formatAutoEnabledActivationReason(
            context.autoEnabledReasons[pluginId],
          ),
        });
    const existingOrigin = seenIds.get(pluginId);
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
      continue;
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
    const pushPluginLoadError = (message: string) =>
      pushPluginValidationError({
        registry,
        seenIds,
        pluginId,
        origin: candidate.origin,
        record,
        message,
      });
    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      markPluginActivationDisabled(record, enableState.reason);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    if (record.format === "bundle") {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }
    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });
    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.error.join(", ")}`);
      pushPluginLoadError(`invalid config: ${validatedConfig.error.join(", ")}`);
      continue;
    }
    const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
    const sourceForCliMetadata =
      candidate.origin === "bundled"
        ? cliMetadataSource
          ? safeRealpathOrResolve(cliMetadataSource)
          : null
        : (cliMetadataSource ?? candidate.source);
    if (!sourceForCliMetadata) {
      record.status = "loaded";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    const opened = openRootFileSync({
      absolutePath: sourceForCliMetadata,
      rootPath: safeRealpathOrResolve(candidate.rootDir),
      boundaryLabel: "plugin root",
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: candidate.origin,
        rootDir: candidate.rootDir,
        env: context.env,
      }),
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    let mod: OpenClawPluginModule | null;
    try {
      mod = withProfile(
        { pluginId: record.id, source: safeSource },
        "cli-metadata",
        () => loadPluginModule(safeSource) as OpenClawPluginModule,
      );
    } catch (error) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "load",
        error,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }
    const { definition, register } = resolvePluginModuleExport(mod);
    if (definition?.id && definition.id !== record.id) {
      pushPluginLoadError(
        `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      );
      continue;
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
    if (!isDreamingSidecar) {
      const memoryDecision = resolveMemorySlotDecision({
        id: record.id,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        record.enabled = false;
        record.status = "disabled";
        record.error = memoryDecision.reason;
        markPluginActivationDisabled(record, memoryDecision.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = record.id;
        record.memorySlotSelected = true;
      }
    }
    if (typeof register !== "function") {
      const wrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
      if (wrongLoaderError) {
        logger.error(
          `[plugins] ${record.id} ${wrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`,
        );
        pushPluginLoadError(wrongLoaderError);
      } else {
        logger.error(`[plugins] ${record.id} missing register/activate export`);
        pushPluginLoadError(formatMissingPluginRegisterError(mod, context.env));
      }
      continue;
    }
    const api = buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      registrationMode: "cli-metadata",
      config: context.cfg,
      pluginConfig: validatedConfig.value,
      runtime: {} as PluginRuntime,
      logger,
      resolvePath: (input) => resolveUserPath(input),
      handlers: {
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      },
    });
    const transaction = createPluginRegistrationTransaction({ registry });
    try {
      withProfile({ pluginId: record.id, source: record.source }, "cli-metadata:register", () =>
        runPluginRegisterSync(register, api),
      );
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      transaction.commit({ activate: true });
    } catch (error) {
      transaction.rollback();
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "register",
        error,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
    }
  }
  return registry;
}

function resolveCliMetadataEntrySource(rootDir: string): string | null {
  for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
    const candidate = path.join(rootDir, basename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
