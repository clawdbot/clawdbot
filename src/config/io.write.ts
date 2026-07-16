import type fs from "node:fs";
import path from "node:path";
import { isVerbose } from "../global-state.js";
import { formatErrorMessage } from "../infra/errors.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { EnvRefArrayMutationError, restoreEnvVarRefs } from "./env-preserve.js";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import type { ConfigIoContext } from "./io.context.js";
import { resolveModelIdNormalizationPolicies } from "./io.context.js";
import {
  collectEnvRefPaths,
  containsConfigIncludeDirective,
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  resolveConfigSnapshotHash,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { loggedConfigWarningFingerprints } from "./io.state.js";
import type {
  ConfigWriteOptions,
  InternalConfigWriteResult,
  ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import {
  applyUnsetPathsForWrite,
  collectChangedPaths,
  formatConfigValidationFailure,
  preserveIncludeOwnedConfigForWrite,
  resolveManagedUnsetPathsForWrite,
  resolvePersistCandidateForWrite,
  restoreEnvRefsFromMap,
} from "./io.write-prepare.js";
import {
  assertBaseSnapshotStillCurrent,
  formatConfigArtifactTimestamp,
  resolveConfigSizeBaselineBytes,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
  stampConfigVersion,
  tightenStateDirPermissionsIfNeeded,
} from "./io.write-safety.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveIncludeRoots } from "./paths.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

export async function writeConfigFileFromContext(
  context: ConfigIoContext,
  cfg: OpenClawConfig,
  options: ConfigWriteOptions,
  readSnapshot: () => Promise<ReadConfigFileSnapshotInternalResult>,
): Promise<InternalConfigWriteResult> {
  const { deps, configPath } = context;
  options.assertConfigPathForWrite?.();
  assertConfigWriteAllowedInCurrentMode({ configPath, env: deps.env });
  const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
  let persistCandidate: unknown = cfg;
  const snapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await readSnapshot();
  const snapshot = snapshotRead.snapshot;
  if (options.baseSnapshot) {
    assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
  }
  let envRefMap: Map<string, string> | null = null;
  let changedPaths: Set<string> | null = null;
  const identityRestoredPaths = new Set<string>();
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  const hasResolvedAuthoredIncludes =
    hasAuthoredIncludes && !containsConfigIncludeDirective(snapshot.sourceConfig);
  if (snapshot.valid && snapshot.exists) {
    persistCandidate = resolvePersistCandidateForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      nextConfig: cfg,
      rootAuthoredConfig: snapshot.parsed,
      unsetPaths,
      explicitSetPaths: options.explicitSetPaths,
      explicitSetValueSource: options.explicitSetValueSource,
      modelIdNormalizationPolicies: resolveModelIdNormalizationPolicies(
        snapshotRead.pluginMetadataSnapshot,
      ),
    });
  } else if (snapshot.exists && hasAuthoredIncludes) {
    persistCandidate = preserveIncludeOwnedConfigForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      nextConfig: cfg,
      rootAuthoredConfig: snapshot.parsed,
    });
  }
  if (snapshot.exists && (snapshot.valid || hasResolvedAuthoredIncludes)) {
    try {
      const resolvedIncludes = resolveConfigIncludes(
        snapshot.parsed,
        configPath,
        {
          readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
          readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
            readConfigIncludeFileWithGuards({
              includePath,
              resolvedPath,
              rootRealDir,
              ioFs: deps.fs,
            }),
          parseJson: (raw) => deps.json5.parse(raw),
        },
        { allowedRoots: resolveIncludeRoots(deps.env, deps.homedir) },
      );
      const collected = new Map<string, string>();
      collectEnvRefPaths(resolvedIncludes, "", collected);
      if (collected.size > 0) {
        envRefMap = collected;
        changedPaths = new Set<string>();
        collectChangedPaths(snapshot.config, cfg, "", changedPaths);
      }
    } catch {
      envRefMap = null;
    }
  }

  persistCandidate = applyUnsetPathsForWrite(persistCandidate as OpenClawConfig, unsetPaths);
  const envForRestore = options.envSnapshotForRestore ?? deps.env;
  const validationSourceCandidate = containsConfigIncludeDirective(persistCandidate)
    ? restoreEnvVarRefs(persistCandidate, snapshot.parsed, envForRestore)
    : persistCandidate;
  const validationCandidate = containsConfigIncludeDirective(validationSourceCandidate)
    ? context.resolveRuntimePreflightSourceConfig(validationSourceCandidate as OpenClawConfig)
    : validationSourceCandidate;
  const validated = validateConfigObjectRawWithPlugins(validationCandidate, {
    env: deps.env,
    pluginValidation: options.skipPluginValidation ? "skip" : "full",
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
  });
  if (!validated.ok) {
    const issue = validated.issues[0];
    throw new Error(
      formatConfigValidationFailure(issue?.path || "<root>", issue?.message ?? "invalid"),
    );
  }
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);

  let cfgToWrite = persistCandidate as OpenClawConfig;
  try {
    if (deps.fs.existsSync(configPath)) {
      const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
      const parsed = parseConfigJson5(currentRaw, deps.json5);
      if (parsed.ok) {
        const beforeIdentityRestore = cfgToWrite;
        cfgToWrite = restoreEnvVarRefs(cfgToWrite, parsed.parsed, envForRestore) as OpenClawConfig;
        collectChangedPaths(beforeIdentityRestore, cfgToWrite, "", identityRestoredPaths);
      }
    }
  } catch (error) {
    if (error instanceof EnvRefArrayMutationError) {
      throw error;
    }
    // A failed current-file reread leaves the already validated candidate unchanged.
  }

  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await tightenStateDirPermissionsIfNeeded({
    configPath,
    env: deps.env,
    homedir: deps.homedir,
    fsModule: deps.fs,
  });
  const outputConfigBase =
    envRefMap && changedPaths
      ? (restoreEnvRefsFromMap(
          cfgToWrite,
          "",
          envRefMap,
          changedPaths,
          identityRestoredPaths,
        ) as OpenClawConfig)
      : cfgToWrite;
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    outputConfigBase,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig;
  const outputConfig = applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths);
  const stampedOutputConfig = stampConfigVersion(outputConfig, options.lastTouchedVersionOverride);
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = resolveConfigSnapshotHash(snapshot);
  const changedPathCount = changedPaths?.size;
  const previousBytes =
    typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
  const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
    raw: snapshot.raw,
    json5: deps.json5,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
  });
  const nextBytes = Buffer.byteLength(json, "utf-8");
  const previousStat = snapshot.exists
    ? await deps.fs.promises.stat(configPath).catch(() => null)
    : null;
  const hasMetaBefore = hasConfigMeta(snapshot.parsed);
  const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
  const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
  const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  const shouldLogInVitest = (name: string) => deps.env.VITEST !== "true" || deps.env[name] === "1";
  const logConfigOverwrite = () => {
    if (
      !snapshot.exists ||
      options.skipOutputLogs ||
      !shouldLogInVitest("OPENCLAW_TEST_CONFIG_OVERWRITE_LOG")
    ) {
      return;
    }
    const testLog = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
    if (!isVerbose() && deps.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    deps.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath,
        previousHash: previousHash ?? null,
        nextHash,
        changedPathCount,
      }),
    );
  };
  const logConfigWriteAnomalies = () => {
    if (
      suspiciousReasons.length === 0 ||
      options.skipOutputLogs ||
      !shouldLogInVitest("OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG")
    ) {
      return;
    }
    const testLog = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
    const showMissingMeta =
      isVerbose() || deps.env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || testLog;
    const visibleReasons = showMissingMeta
      ? suspiciousReasons
      : suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
    if (visibleReasons.length > 0) {
      deps.logger.warn(`Config write anomaly: ${configPath} (${visibleReasons.join(", ")})`);
    }
  };

  const auditRecordBase = createConfigWriteAuditRecordBase({
    configPath,
    env: deps.env,
    existsBefore: snapshot.exists,
    previousHash: previousHash ?? null,
    nextHash,
    previousBytes,
    nextBytes,
    previousMetadata: resolveConfigStatMetadata(previousStat),
    changedPathCount,
    hasMetaBefore,
    hasMetaAfter,
    gatewayModeBefore,
    gatewayModeAfter,
    suspicious: suspiciousReasons,
  });
  const appendWriteAudit = async (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => {
    await appendConfigAuditRecord({
      fs: deps.fs,
      env: deps.env,
      homedir: deps.homedir,
      record: finalizeConfigWriteAuditRecord({
        base: auditRecordBase,
        result,
        err: error,
        nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
      }),
    });
  };
  const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons, options);
  if (blockingReasons.length > 0 && options.allowDestructiveWrite !== true) {
    const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
    await deps.fs.promises
      .writeFile(rejectedPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      .catch(() => {});
    const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). Rejected payload saved to ${rejectedPath}.`;
    const error = Object.assign(new Error(message), {
      code: "CONFIG_WRITE_REJECTED",
      rejectedPath,
      reasons: blockingReasons,
    });
    deps.logger.warn(message);
    await appendWriteAudit("rejected", error);
    throw error;
  }

  const preCommitRuntimePreflight =
    options.preCommitRuntimePreflight ??
    (async (sourceConfig: OpenClawConfig) => {
      await preflightRuntimeSnapshotWrite({
        nextSourceConfig: sourceConfig,
        refreshOptions: options.runtimeRefresh,
        formatRefreshError: (error) => formatErrorMessage(error),
        createRefreshError: (detail, cause) =>
          new ConfigRuntimeRefreshError(
            `Config write blocked before committing ${configPath}: active SecretRef resolution failed: ${detail}`,
            { cause },
          ),
      });
    });
  await preCommitRuntimePreflight(context.resolveRuntimePreflightSourceConfig(stampedOutputConfig));

  const pluginMigration = context.ensureShippedPluginInstallConfigRecordsMigratedForWrite(snapshot);
  let configCommitted = false;
  try {
    const result = await replaceFileAtomic({
      filePath: configPath,
      content: json,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: deps.fs,
      beforeRename: async () => {
        options.assertConfigPathForWrite?.();
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
        if (deps.fs.existsSync(configPath)) {
          await maintainConfigBackups(configPath, deps.fs.promises);
        }
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
        options.assertConfigPathForWrite?.();
        // Warn only after final guards pass, with no later await before rename.
        warnIfJSON5CommentsWillBeStripped({
          raw: snapshot.raw,
          filePath: configPath,
          warn: (message) => deps.logger.warn(message),
          skipOutputLogs: options.skipOutputLogs,
        });
      },
    });
    configCommitted = true;
    try {
      options.assertConfigPathForWrite?.();
    } catch (error) {
      try {
        const rolledBack = await rollbackConfigFileWriteIfUnchanged({
          configPath,
          previousSnapshot: snapshot,
          committedHash: nextHash,
          fsModule: deps.fs,
        });
        if (rolledBack) {
          context.rollbackShippedPluginInstallConfigWriteMigration(pluginMigration);
        }
      } catch (rollbackError) {
        throw new ConfigRuntimeRefreshError(
          `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    logConfigOverwrite();
    logConfigWriteAnomalies();
    await appendWriteAudit(
      result.method,
      undefined,
      await deps.fs.promises.stat(configPath).catch(() => null),
    );
    if (!options.skipPluginValidation) {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    return {
      persistedHash: nextHash,
      persistedConfig: stampedOutputConfig,
      ...(pluginMigration.migrated || !options.skipPluginValidation
        ? {
            [configWritePostCommitRollback]: () => {
              context.rollbackShippedPluginInstallConfigWriteMigration(pluginMigration);
              if (previousWarningFingerprint === undefined) {
                loggedConfigWarningFingerprints.delete(configPath);
              } else {
                loggedConfigWarningFingerprints.set(configPath, previousWarningFingerprint);
              }
            },
          }
        : {}),
    };
  } catch (error) {
    if (!configCommitted) {
      context.rollbackShippedPluginInstallConfigWriteMigration(pluginMigration);
    }
    await appendWriteAudit("failed", error);
    throw error;
  }
}
