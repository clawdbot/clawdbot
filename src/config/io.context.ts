import crypto from "node:crypto";
import path from "node:path";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { formatErrorMessage } from "../infra/errors.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { createConfigValidationMetadataPluginIdScope } from "../plugins/gateway-startup-plugin-ids.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { applyConfigEnvVars, cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { retainGeneratedOwnerDisplaySecret } from "./io.owner-display-secret.js";
import {
  coerceConfig,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "./io.read-helpers.js";
import { autoOwnerDisplaySecretByPath } from "./io.state.js";
import type {
  ConfigIoFactoryOptions,
  NormalizedConfigIoDeps,
  ShippedPluginInstallConfigReadMigration,
  ShippedPluginInstallConfigWriteMigration,
} from "./io.types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { resolveStateDir } from "./paths.js";
import {
  extractShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "./plugin-install-config-migration.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ValidationPluginMetadataSnapshotLoader = {
  load: (config: OpenClawConfig) => PluginMetadataSnapshot;
  getSnapshot: () => PluginMetadataSnapshot | undefined;
};

export type ConfigIoContext = {
  deps: NormalizedConfigIoDeps;
  configPath: string;
  options: ConfigIoFactoryOptions;
  observeLoadConfigSnapshot: (snapshot: ConfigFileSnapshot) => ConfigFileSnapshot;
  finalizeLoadedRuntimeConfig: (config: OpenClawConfig) => OpenClawConfig;
  migrateAndStripShippedPluginInstallConfigRecords: (
    configRaw: unknown,
    options?: { persist?: boolean; rootConfigRaw?: unknown },
  ) => ShippedPluginInstallConfigReadMigration;
  retainRuntimeOnlyShippedPluginInstallConfigRecords: (
    config: OpenClawConfig,
    sourceRaw: unknown,
  ) => OpenClawConfig;
  createValidationPluginMetadataSnapshotLoader: (params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
  }) => ValidationPluginMetadataSnapshotLoader;
  resolveRuntimePreflightSourceConfig: (candidate: OpenClawConfig) => OpenClawConfig;
  ensureShippedPluginInstallConfigRecordsMigratedForWrite: (
    snapshot: ConfigFileSnapshot,
  ) => ShippedPluginInstallConfigWriteMigration;
  rollbackShippedPluginInstallConfigWriteMigration: (
    migration: ShippedPluginInstallConfigWriteMigration,
  ) => boolean;
  resolveSuspiciousRecoveryBackupCandidate: (parsed: unknown) => OpenClawConfig | null;
};

export function createConfigIoContext(options: ConfigIoFactoryOptions = {}): ConfigIoContext {
  const deps = normalizeConfigIoDeps(options);
  const configPath = resolveConfigPathForDeps(deps);

  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    if (deps.observe) {
      observeConfigSnapshotSync(deps, snapshot);
    }
    return snapshot;
  }

  function finalizeLoadedRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
    const duplicates = findDuplicateAgentDirs(cfg, { env: deps.env, homedir: deps.homedir });
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }
    applyConfigEnvVars(cfg, deps.env);
    const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
    if (enabled && options.shellEnvFallback !== "defer" && !shouldDeferShellEnvFallback(deps.env)) {
      loadShellEnvFallback({
        enabled: true,
        env: deps.env,
        expectedKeys: resolveShellEnvExpectedKeys(deps.env),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }
    const pendingValue = autoOwnerDisplaySecretByPath.get(configPath);
    const { config: resolvedConfig, generatedSecret } = ensureOwnerDisplaySecret(
      cfg,
      () => pendingValue ?? crypto.randomBytes(32).toString("hex"),
    );
    return applyConfigOverrides(
      retainGeneratedOwnerDisplaySecret({
        config: resolvedConfig,
        configPath,
        generatedSecret,
        state: { pendingByPath: autoOwnerDisplaySecretByPath },
      }),
    );
  }

  function replaceConfigFileSync(raw: string): void {
    replaceFileAtomicSync({
      filePath: configPath,
      content: raw,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: deps.fs,
    });
  }

  function migrateAndStripShippedPluginInstallConfigRecords(
    configRaw: unknown,
    migrationOptions: { persist?: boolean; rootConfigRaw?: unknown } = {},
  ): ShippedPluginInstallConfigReadMigration {
    const installRecords = extractShippedPluginInstallConfigRecords(configRaw);
    const stripped = stripShippedPluginInstallConfigRecords(configRaw);
    if (Object.keys(installRecords).length === 0) {
      return { config: stripped };
    }
    if (migrationOptions.persist === false) {
      return { config: configRaw, validationConfig: stripped };
    }
    try {
      const stateDir = resolveStateDir(deps.env, deps.homedir);
      const existingRecords = loadInstalledPluginIndexInstallRecordsSync({
        env: deps.env,
        stateDir,
      });
      const nextRecords = { ...installRecords, ...existingRecords };
      if (Object.keys(installRecords).some((pluginId) => !(pluginId in existingRecords))) {
        writePersistedInstalledPluginIndexInstallRecordsSync(nextRecords, {
          config: coerceConfig(stripped),
          env: deps.env,
          stateDir,
        });
      }
      const rootConfigRaw = migrationOptions.rootConfigRaw;
      if (
        rootConfigRaw !== undefined &&
        Object.keys(extractShippedPluginInstallConfigRecords(rootConfigRaw)).length > 0
      ) {
        const persistedRootParsed = stripShippedPluginInstallConfigRecords(rootConfigRaw);
        const persistedRootRaw = JSON.stringify(persistedRootParsed, null, 2)
          .trimEnd()
          .concat("\n");
        replaceConfigFileSync(persistedRootRaw);
        return { config: stripped, persistedRootParsed, persistedRootRaw };
      }
    } catch (error) {
      deps.logger.warn(
        `Config (${configPath}): could not migrate shipped plugins.installs records into the plugin index: ${formatErrorMessage(error)}`,
      );
      return { config: configRaw };
    }
    return { config: stripped };
  }

  function retainRuntimeOnlyShippedPluginInstallConfigRecords(
    config: OpenClawConfig,
    sourceRaw: unknown,
  ): OpenClawConfig {
    const installRecords = extractShippedPluginInstallConfigRecords(sourceRaw);
    if (Object.keys(installRecords).length === 0) {
      return config;
    }
    return { ...config, plugins: { ...config.plugins, installs: installRecords } };
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
  }): ValidationPluginMetadataSnapshotLoader {
    let snapshot: PluginMetadataSnapshot | undefined;
    return {
      load: (config) => {
        if (snapshot) {
          return snapshot;
        }
        const metadataConfig = retainRuntimeOnlyShippedPluginInstallConfigRecords(
          config,
          params.effectiveConfigRaw,
        );
        const defaultAgentId = resolveDefaultAgentId(metadataConfig);
        snapshot = resolvePluginMetadataSnapshot({
          config: metadataConfig,
          workspaceDir: resolveAgentWorkspaceDir(metadataConfig, defaultAgentId, params.env),
          env: params.env,
          allowWorkspaceScopedCurrent: true,
          pluginIdScope: createConfigValidationMetadataPluginIdScope({
            config: metadataConfig,
            env: params.env,
          }),
        });
        return snapshot;
      },
      getSnapshot: () => snapshot,
    };
  }

  function resolveRuntimePreflightSourceConfig(candidate: OpenClawConfig): OpenClawConfig {
    const env = { ...deps.env } as NodeJS.ProcessEnv;
    const resolvedIncludes = resolveConfigIncludesForRead(candidate, configPath, { ...deps, env });
    const resolution = resolveConfigForRead(resolvedIncludes, env, deps.lowerPrecedenceEnv);
    return coerceConfig(
      migrateAndStripShippedPluginInstallConfigRecords(resolution.resolvedConfigRaw, {
        persist: false,
        rootConfigRaw: candidate,
      }).config,
    );
  }

  function ensureShippedPluginInstallConfigRecordsMigratedForWrite(
    snapshot: ConfigFileSnapshot,
  ): ShippedPluginInstallConfigWriteMigration {
    const installRecords = {
      ...extractShippedPluginInstallConfigRecords(snapshot.sourceConfig),
      ...extractShippedPluginInstallConfigRecords(snapshot.parsed),
    };
    if (Object.keys(installRecords).length === 0) {
      return { migrated: false };
    }
    const stateDir = resolveStateDir(deps.env, deps.homedir);
    const existingRecords = loadInstalledPluginIndexInstallRecordsSync({ env: deps.env, stateDir });
    if (Object.keys(installRecords).every((pluginId) => pluginId in existingRecords)) {
      return { migrated: false };
    }
    try {
      writePersistedInstalledPluginIndexInstallRecordsSync(
        { ...installRecords, ...existingRecords },
        {
          config: coerceConfig(stripShippedPluginInstallConfigRecords(snapshot.sourceConfig)),
          env: deps.env,
          stateDir,
        },
      );
      return { migrated: true };
    } catch (error) {
      throw new Error(
        `Config write blocked: shipped plugins.installs records in ${configPath} could not be migrated into the plugin index. Fix state directory permissions or run openclaw plugins registry --refresh, then retry. ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function rollbackShippedPluginInstallConfigWriteMigration(
    migration: ShippedPluginInstallConfigWriteMigration,
  ): boolean {
    if (!migration.migrated) {
      return false;
    }
    return false;
  }

  function resolveSuspiciousRecoveryBackupCandidate(parsed: unknown): OpenClawConfig | null {
    try {
      const candidateEnv = cloneEnvWithPlatformSemantics(deps.env);
      const resolved = resolveConfigIncludesForRead(parsed, configPath, {
        ...deps,
        env: candidateEnv,
      });
      const resolution = resolveConfigForRead(resolved, candidateEnv, deps.lowerPrecedenceEnv);
      const migration = migrateAndStripShippedPluginInstallConfigRecords(
        resolution.resolvedConfigRaw,
        { persist: false, rootConfigRaw: parsed },
      );
      const effectiveConfigRaw = migration.config;
      const validationConfigRaw = migration.validationConfig ?? effectiveConfigRaw;
      const pluginMetadata = createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw,
        env: candidateEnv,
      });
      const validated = validateConfigObjectWithPlugins(validationConfigRaw, {
        env: candidateEnv,
        pluginValidation: options.pluginValidation,
        loadPluginMetadataSnapshot: pluginMetadata.load,
        sourceRaw: parsed,
        preservedLegacyRootKeys: options.preservedLegacyRootKeys,
      });
      return validated.ok ? coerceConfig(effectiveConfigRaw) : null;
    } catch {
      return null;
    }
  }

  return {
    deps,
    configPath,
    options,
    observeLoadConfigSnapshot,
    finalizeLoadedRuntimeConfig,
    migrateAndStripShippedPluginInstallConfigRecords,
    retainRuntimeOnlyShippedPluginInstallConfigRecords,
    createValidationPluginMetadataSnapshotLoader,
    resolveRuntimePreflightSourceConfig,
    ensureShippedPluginInstallConfigRecordsMigratedForWrite,
    rollbackShippedPluginInstallConfigWriteMigration,
    resolveSuspiciousRecoveryBackupCandidate,
  };
}

export function resolveModelIdNormalizationPolicies(snapshot: PluginMetadataSnapshot | undefined) {
  return snapshot ? collectManifestModelIdNormalizationPolicies(snapshot.plugins) : undefined;
}

export function materializeConfigForLoad(
  context: ConfigIoContext,
  config: OpenClawConfig,
  effectiveConfigRaw: unknown,
  pluginMetadata: PluginMetadataSnapshot | undefined,
): OpenClawConfig {
  return context.retainRuntimeOnlyShippedPluginInstallConfigRecords(
    materializeRuntimeConfig(config, "load", {
      manifestRegistry: pluginMetadata?.manifestRegistry,
    }),
    effectiveConfigRaw,
  );
}
