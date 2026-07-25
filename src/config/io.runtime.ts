import fs from "node:fs";
import { formatErrorMessage } from "../infra/errors.js";
import { cloneEnvWithPlatformSemantics, createConfigRuntimeEnvBase } from "./config-env-vars.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { createConfigIO } from "./io.factory.js";
import {
  coerceConfig,
  createManagedRuntimeEnvBase,
  replaceEnvSnapshot,
  resolveManagedRuntimeEnvBaseline,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import type {
  BestEffortConfigSnapshot,
  ConfigSnapshotReadOptions,
  ConfigWriteNotification,
  ConfigWriteOptions,
  ConfigWriteResult,
  ReadConfigFileSnapshotForWriteResult,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import {
  createMergePatch,
  resolveManagedUnsetPathsForWrite,
  resolveWriteEnvSnapshotForPath,
} from "./io.write-prepare.js";
import { rollbackConfigFileWriteIfUnchanged } from "./io.write-safety.js";
import { applyMergePatch } from "./merge-patch.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import {
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  hasManagedRuntimeConfigWriteOwner,
  loadPinnedRuntimeConfig,
  notifyRuntimeConfigWriteListeners,
  preflightManagedRuntimeConfigWrite,
  preflightRuntimeSnapshotWrite,
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  type RuntimeConfigSnapshotRefreshOptions,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}

export function registerConfigWriteListener(
  listener: (event: ConfigWriteNotification) => void,
  options: {
    ownsRuntimeActivationFor?: string;
    preCommitRuntimePreflight?: (
      sourceConfig: OpenClawConfig,
      refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
    ) => Promise<RuntimeConfigWritePreparedCandidate>;
  } = {},
): () => void {
  const unregisterOwner = options.ownsRuntimeActivationFor
    ? registerManagedRuntimeConfigWriteOwner(
        options.ownsRuntimeActivationFor,
        options.preCommitRuntimePreflight,
      )
    : undefined;
  const unregisterListener = registerRuntimeConfigWriteListener((event) => {
    const {
      preparedCandidate: _preparedCandidate,
      preparedCandidatesByOwner: _preparedCandidatesByOwner,
      ...baseEvent
    } = event;
    const preparedCandidate = unregisterOwner
      ? event.preparedCandidatesByOwner?.get(unregisterOwner.ownerId)
      : undefined;
    listener({ ...baseEvent, ...(preparedCandidate ? { preparedCandidate } : {}) });
  });
  return () => {
    unregisterListener();
    unregisterOwner?.();
  };
}

export function loadConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
  const loadFresh = () =>
    createConfigIO({
      ...(options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
      ...(options?.skipShellEnvFallback ? { shellEnvFallback: "defer" as const } : {}),
    }).loadConfig();
  return options?.pin === false ? loadFresh() : loadPinnedRuntimeConfig(loadFresh);
}

export function getRuntimeConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
  return loadConfig(options);
}

export async function readBestEffortConfig(options?: {
  isolateEnv?: boolean;
  observe?: boolean;
  skipPluginValidation?: boolean;
}): Promise<OpenClawConfig> {
  return await createConfigIO({
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" } : {}),
  }).readBestEffortConfig();
}

export async function readBestEffortConfigSnapshot(options?: {
  observe?: boolean;
  skipPluginValidation?: boolean;
}): Promise<BestEffortConfigSnapshot> {
  return await createConfigIO({
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" } : {}),
  }).readBestEffortConfigSnapshot();
}

export async function readSourceConfigBestEffort(): Promise<OpenClawConfig> {
  return await createConfigIO().readSourceConfigBestEffort();
}

export async function readConfigFileSnapshot(
  options: ConfigSnapshotReadOptions = {},
): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    ...(options.measure ? { measure: options.measure } : {}),
    ...(options.observe === false ? { observe: false } : {}),
    ...(options.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
    ...(options.skipPluginValidation ? { pluginValidation: "skip" } : {}),
    ...(options.suppressFutureVersionWarning ? { suppressFutureVersionWarning: true } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
  }).readConfigFileSnapshot({
    recoverSuspicious: options.recoverSuspicious === true,
    allowSuspiciousRecovery: options.allowSuspiciousRecovery,
  });
}

export async function readConfigFileSnapshotWithPluginMetadata(
  options?: Pick<
    ConfigSnapshotReadOptions,
    | "allowSuspiciousRecovery"
    | "isolateEnv"
    | "lowerPrecedenceEnv"
    | "measure"
    | "observe"
    | "recoverSuspicious"
  >,
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  return await createConfigIO({
    ...(options?.measure ? { measure: options.measure } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
  }).readConfigFileSnapshotWithPluginMetadata({
    recoverSuspicious: options?.recoverSuspicious === true,
    allowSuspiciousRecovery: options?.allowSuspiciousRecovery,
  });
}

export async function promoteConfigSnapshotToLastKnownGood(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().promoteConfigSnapshotToLastKnownGood(snapshot);
}

export async function recoverConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  return await createConfigIO().recoverConfigFromLastKnownGood(params);
}

export async function preserveConfigSnapshotAsClobbered(
  snapshot: ConfigFileSnapshot,
): Promise<string | null> {
  return await createConfigIO().preserveConfigSnapshotAsClobbered(snapshot);
}

export async function recoverConfigFromJsonRootSuffix(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().recoverConfigFromJsonRootSuffix(snapshot);
}

export async function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot> {
  return await readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForRuntimeTransaction(
  activeSourceConfig: OpenClawConfig,
): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    env: createConfigRuntimeEnvBase(activeSourceConfig, process.env, {
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    }),
  }).readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(options?: {
  skipPluginValidation?: boolean;
}): Promise<ReadConfigFileSnapshotForWriteResult> {
  const readOptions = options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const processIo = createConfigIO(readOptions);
      const io = hasManagedRuntimeConfigWriteOwner(processIo.configPath)
        ? createConfigIO({ ...readOptions, env: createManagedRuntimeEnvBase() })
        : processIo;
      const result = await io.readConfigFileSnapshotForWrite();
      result.writeOptions.assertConfigPathForWrite?.();
      return result;
    } catch (error) {
      if (!(error instanceof ConfigMutationConflictError) || error.retryable || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

export async function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<ConfigWriteResult> {
  options.assertConfigPathForWrite?.();
  const ioOptions = {
    ...(options.ownedConfigPathForWrite ? { configPath: options.ownedConfigPathForWrite } : {}),
    ...(options.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
  };
  const processIo = createConfigIO(ioOptions);
  const deferRuntimeActivation = hasManagedRuntimeConfigWriteOwner(processIo.configPath);
  const io = deferRuntimeActivation
    ? createConfigIO({ ...ioOptions, env: createManagedRuntimeEnvBase() })
    : processIo;
  assertConfigWriteAllowedInCurrentMode({ configPath: io.configPath });
  let nextCfg = cfg;
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  if (hadBothSnapshots) {
    const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
  }
  const baseSnapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await io.readConfigFileSnapshotWithPluginMetadata();
  const baseSnapshot = baseSnapshotRead.snapshot;
  if (deferRuntimeActivation) {
    replaceEnvSnapshot(io.env, createManagedRuntimeEnvBase());
  }
  let runtimePreflightResult: unknown;
  let managedPreparedCandidates = new Map<symbol, RuntimeConfigWritePreparedCandidate>();
  const writeResult = await io.writeConfigFile(nextCfg, {
    baseSnapshot,
    basePluginMetadataSnapshot: baseSnapshotRead.pluginMetadataSnapshot,
    assertConfigPathForWrite: options.assertConfigPathForWrite,
    envSnapshotForRestore: resolveWriteEnvSnapshotForPath({
      actualConfigPath: io.configPath,
      expectedConfigPath: options.expectedConfigPath,
      envSnapshotForRestore: options.envSnapshotForRestore,
    }),
    unsetPaths: resolveManagedUnsetPathsForWrite(options.unsetPaths),
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetPaths
      ? (options.explicitSetValueSource ?? cfg)
      : undefined,
    afterWrite: options.afterWrite,
    allowDestructiveWrite: options.allowDestructiveWrite,
    allowConfigSizeDrop: options.allowConfigSizeDrop,
    skipRuntimeSnapshotRefresh: options.skipRuntimeSnapshotRefresh,
    skipOutputLogs: options.skipOutputLogs,
    skipPluginValidation: options.skipPluginValidation,
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
    preCommitRuntimePreflight: async (sourceConfig) => {
      if (deferRuntimeActivation) {
        managedPreparedCandidates = await preflightManagedRuntimeConfigWrite(
          io.configPath,
          sourceConfig,
          options.runtimeRefresh,
        );
      } else {
        runtimePreflightResult = await preflightRuntimeSnapshotWrite({
          nextSourceConfig: sourceConfig,
          refreshOptions: options.runtimeRefresh,
          formatRefreshError: (error) => formatErrorMessage(error),
          createRefreshError: (detail, cause) =>
            new ConfigRuntimeRefreshError(
              `Config write blocked before committing ${io.configPath}: active SecretRef resolution failed: ${detail}`,
              { cause },
            ),
        });
      }
      await options.preCommitRuntimePreflight?.(sourceConfig);
    },
  });
  if (
    options.skipRuntimeSnapshotRefresh &&
    !hadRuntimeSnapshot &&
    !getRuntimeConfigSnapshotRefreshHandler()
  ) {
    return writeResult;
  }
  if (deferRuntimeActivation) {
    replaceEnvSnapshot(io.env, createManagedRuntimeEnvBase());
  }
  return await finalizeCommittedConfigWrite({
    io,
    options,
    nextCfg,
    writeResult,
    baseSnapshot,
    hadRuntimeSnapshot,
    hadBothSnapshots,
    deferRuntimeActivation,
    runtimePreflightResult,
    managedPreparedCandidates,
  });
}

async function finalizeCommittedConfigWrite(params: {
  io: ReturnType<typeof createConfigIO>;
  options: ConfigWriteOptions;
  nextCfg: OpenClawConfig;
  writeResult: Awaited<ReturnType<ReturnType<typeof createConfigIO>["writeConfigFile"]>>;
  baseSnapshot: ConfigFileSnapshot;
  hadRuntimeSnapshot: boolean;
  hadBothSnapshots: boolean;
  deferRuntimeActivation: boolean;
  runtimePreflightResult: unknown;
  managedPreparedCandidates: Map<symbol, RuntimeConfigWritePreparedCandidate>;
}): Promise<ConfigWriteResult> {
  const {
    io,
    options,
    writeResult,
    baseSnapshot,
    deferRuntimeActivation,
    managedPreparedCandidates,
  } = params;
  let canonicalSourceConfig = params.nextCfg;
  let canonicalRuntimeConfig = params.nextCfg;
  let envBeforeCanonicalRead = snapshotEnv(io.env);
  let envAfterCanonicalRead: Record<string, string | undefined>;
  let canonicalReadFailure: ConfigRuntimeRefreshError | null = null;
  try {
    let stableEnvGeneration = !deferRuntimeActivation;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const baseline = resolveManagedRuntimeEnvBaseline();
      if (deferRuntimeActivation) {
        replaceEnvSnapshot(
          io.env,
          createConfigRuntimeEnvBase(baseline.sourceConfig, process.env, {
            preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
          }),
        );
        envBeforeCanonicalRead = snapshotEnv(io.env);
      }
      const freshSnapshot = await io.readConfigFileSnapshot();
      if (freshSnapshot.exists && freshSnapshot.valid) {
        canonicalSourceConfig = freshSnapshot.sourceConfig;
        canonicalRuntimeConfig = freshSnapshot.config;
      }
      if (
        !deferRuntimeActivation ||
        resolveManagedRuntimeEnvBaseline().generation === baseline.generation
      ) {
        stableEnvGeneration = true;
        break;
      }
    }
    if (!stableEnvGeneration) {
      canonicalReadFailure = new ConfigRuntimeRefreshError(
        `Config was written to ${io.configPath}, but the active config environment changed during every canonical reread`,
      );
    }
  } catch (error) {
    canonicalReadFailure = new ConfigRuntimeRefreshError(
      `Config was written to ${io.configPath}, but the canonical reread failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    envAfterCanonicalRead = snapshotEnv(io.env);
  }

  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshot();
    const notificationRuntimeConfig = deferRuntimeActivation
      ? canonicalRuntimeConfig
      : currentRuntimeConfig;
    if (!notificationRuntimeConfig) {
      return;
    }
    const notificationPreparedCandidates = new Map(
      [...managedPreparedCandidates].map(([ownerId, candidate]) => [
        ownerId,
        {
          ...candidate,
          runtimeConfig:
            candidate.reapplyRuntimeOverlays?.(canonicalRuntimeConfig) ?? candidate.runtimeConfig,
          compareConfig:
            candidate.reapplyCompareOverlays?.(canonicalSourceConfig) ?? candidate.compareConfig,
        },
      ]),
    );
    notifyRuntimeConfigWriteListeners(
      createRuntimeConfigWriteNotification({
        configPath: io.configPath,
        sourceConfig: canonicalSourceConfig,
        runtimeConfig: notificationRuntimeConfig,
        persistedHash: writeResult.persistedHash,
        afterWrite: options.afterWrite,
        runtimeRefresh: options.runtimeRefresh,
        ...(notificationPreparedCandidates.size > 0
          ? { preparedCandidatesByOwner: notificationPreparedCandidates }
          : {}),
      }),
    );
  };

  try {
    if (canonicalReadFailure) {
      throw canonicalReadFailure;
    }
    options.assertConfigPathForWrite?.();
    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: canonicalSourceConfig,
      refreshOptions: options.runtimeRefresh,
      hadRuntimeSnapshot: params.hadRuntimeSnapshot,
      hadBothSnapshots: params.hadBothSnapshots,
      loadFreshConfig: () => io.loadConfig(),
      notifyCommittedWrite,
      formatRefreshError: (error) => formatErrorMessage(error),
      preflightResult: params.runtimePreflightResult,
      deferRuntimeActivation,
      createRefreshError: (detail, cause) =>
        new ConfigRuntimeRefreshError(
          `Config was written to ${io.configPath}, but runtime snapshot refresh failed: ${detail}`,
          { cause },
        ),
    });
  } catch (error) {
    try {
      const rolledBackConfig = await rollbackConfigFileWriteIfUnchanged({
        configPath: io.configPath,
        previousSnapshot: baseSnapshot,
        committedHash: writeResult.persistedHash,
        fsModule: fs,
      });
      if (rolledBackConfig) {
        restoreEnvChangesIfUnchanged({
          env: io.env,
          before: envBeforeCanonicalRead,
          after: envAfterCanonicalRead,
        });
        writeResult[configWritePostCommitRollback]?.();
      }
    } catch (rollbackError) {
      throw new ConfigRuntimeRefreshError(
        `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { ...writeResult, persistedConfig: canonicalSourceConfig };
}
