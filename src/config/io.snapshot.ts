import { formatErrorMessage } from "../infra/errors.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  includeContributionOwnsAgentRoster,
  includeContributionOwnsBindings,
} from "./agent-roster-provenance.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { ConfigIncludeError } from "./includes.js";
import type { ConfigIoContext } from "./io.context.js";
import { maybeRecoverSuspiciousConfigRead } from "./io.observe-recovery.js";
import {
  coerceConfig,
  containsConfigIncludeDirective,
  hashConfigRaw,
  maybeLoadDotEnvForConfig,
  parseConfigJson5,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import {
  collectInvalidConfigLegacyIssues,
  createConfigFileSnapshot,
  finalizeReadConfigSnapshotInternalResult,
} from "./io.snapshot-shared.js";
import type {
  BestEffortConfigSnapshot,
  ConfigSnapshotReadOptions,
  ReadConfigFileSnapshotForWriteResult,
  ReadConfigFileSnapshotInternalResult,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { warnIfConfigFromFuture } from "./io.warnings.js";
import {
  findLegacyConfigIssues,
  migrateLegacyContextBudgetConfig,
  migratePersistedImplicitMainRoster,
} from "./legacy.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot, LegacyConfigIssue, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type InternalReadOptions = {
  allowCurrentPluginMetadata?: boolean;
  recoverSuspicious?: boolean;
  skipSuspiciousRecovery?: boolean;
  allowSuspiciousRecovery?: (
    candidate: OpenClawConfig,
    current: OpenClawConfig,
  ) => boolean | Promise<boolean>;
};

function listResolvedIncludePaths(includeFilePathsForWatch: ReadonlySet<string>): string[] {
  return [...includeFilePathsForWatch].toSorted();
}

export async function readConfigFileSnapshotInternal(
  context: ConfigIoContext,
  options: InternalReadOptions = {},
): Promise<ReadConfigFileSnapshotInternalResult> {
  const { deps, configPath } = context;
  maybeLoadDotEnvForConfig(deps.env);
  const envBeforeRead = snapshotEnv(deps.env);
  if (!deps.fs.existsSync(configPath)) {
    const migrated = migratePersistedImplicitMainRoster({});
    const config = coerceConfig(migrated.config);
    const metadata = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw: config,
      env: deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    const coreOnly = context.options.pluginValidation === "core-only";
    const legacyIssues: LegacyConfigIssue[] = [];
    return await finalizeReadConfigSnapshotInternalResult(deps, {
      snapshot: createConfigFileSnapshot({
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        sourceConfig: config,
        valid: true,
        // Missing config is the fresh-install default path: materialize the
        // same runtime defaults an existing empty {} config gets, so snapshot
        // consumers see identical out-of-box behavior either way.
        runtimeConfig: materializeRuntimeConfig(
          config,
          coreOnly
            ? { manifestRegistry: { plugins: [] } }
            : { loadManifestRegistry: () => metadata.load(config).manifestRegistry },
        ),
        hash: hashConfigRaw(null),
        issues: [],
        warnings: [],
        legacyIssues,
      }),
      pluginMetadataSnapshot: metadata.getSnapshot(),
    });
  }

  let fallbackRaw: string | null = null;
  let fallbackParsed: unknown = {};
  let fallbackSourceConfig: OpenClawConfig = {};
  let fallbackHash = hashConfigRaw(null);
  let fallbackEnvSnapshotForRestore: Record<string, string | undefined> | undefined;
  const includeFileHashesForWrite: Record<string, string> = {};
  const includeFileTargetsForWrite: Record<string, string> = {};
  const includeFilePathsForWatch = new Set<string>();
  const includeProvenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number][] = [];
  let agentRosterIncludeOwned = false;
  let bindingsIncludeOwned = false;

  try {
    const raw = await deps.measure("config.snapshot.read.file", () =>
      deps.fs.readFileSync(configPath, "utf-8"),
    );
    const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw(raw));
    fallbackRaw = raw;
    fallbackHash = rawHash;
    const parsedRes = await deps.measure("config.snapshot.read.parse", () =>
      parseConfigJson5(raw, deps.json5),
    );
    if (!parsedRes.ok) {
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
          exists: true,
          raw,
          parsed: {},
          sourceConfig: {},
          valid: false,
          runtimeConfig: {},
          hash: rawHash,
          issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
          warnings: [],
          legacyIssues: [],
        }),
      });
    }
    const effectiveParsed = parsedRes.parsed;
    fallbackParsed = effectiveParsed;
    fallbackSourceConfig = coerceConfig(effectiveParsed);

    let resolved: unknown;
    try {
      resolved = await deps.measure("config.snapshot.read.includes", () =>
        resolveConfigIncludesForRead(
          effectiveParsed,
          configPath,
          deps,
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
          includeFilePathsForWatch,
          (event) => {
            const { value: _value, ...ownership } = event;
            includeProvenance.push(ownership);
            agentRosterIncludeOwned ||= includeContributionOwnsAgentRoster(event);
            bindingsIncludeOwned ||= includeContributionOwnsBindings(event);
          },
        ),
      );
    } catch (error) {
      const message =
        error instanceof ConfigIncludeError
          ? error.message
          : `Include resolution failed: ${String(error)}`;
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
          exists: true,
          raw,
          parsed: effectiveParsed,
          sourceConfig: coerceConfig(effectiveParsed),
          valid: false,
          runtimeConfig: coerceConfig(effectiveParsed),
          hash: rawHash,
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        }),
        includeFileHashesForWrite,
        includeFileTargetsForWrite,
      });
    }

    const readResolution = await deps.measure("config.snapshot.read.env", () =>
      resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv),
    );
    fallbackEnvSnapshotForRestore = readResolution.envSnapshotForRestore;
    const envVarWarnings = readResolution.envWarnings.map((warning) => ({
      path: warning.configPath,
      message: `Missing env var "${warning.varName}" - feature using this value will be unavailable`,
    }));
    const contextBudgetMigration = migrateLegacyContextBudgetConfig(
      readResolution.resolvedConfigRaw,
    );
    const rosterMigration = migratePersistedImplicitMainRoster(contextBudgetMigration.config);
    envVarWarnings.push(
      ...contextBudgetMigration.changes,
      ...contextBudgetMigration.warnings,
      ...rosterMigration.diagnostics.map((message) => ({ path: "agents.entries", message })),
    );
    const effectiveConfigRaw = rosterMigration.config;
    const validationConfigRaw = effectiveConfigRaw;
    const snapshotRaw = raw;
    const snapshotParsed = effectiveParsed;
    const snapshotHash = rawHash;
    fallbackSourceConfig = coerceConfig(effectiveConfigRaw);
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw,
      env: deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    const validated = await deps.measure("config.snapshot.read.validate", () =>
      validateConfigObjectWithPlugins(validationConfigRaw, {
        env: deps.env,
        pluginValidation: context.options.pluginValidation,
        loadPluginMetadataSnapshot: pluginMetadata.load,
        sourceRaw: effectiveParsed,
        preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
      }),
    );
    if (!validated.ok) {
      const availableSnapshot = pluginMetadata.getSnapshot();
      const collect = () =>
        context.options.pluginValidation === "core-only"
          ? findLegacyConfigIssues(effectiveConfigRaw, effectiveParsed)
          : collectInvalidConfigLegacyIssues(effectiveConfigRaw, effectiveParsed);
      const legacyIssues = await deps.measure("config.snapshot.read.legacy-issues", () =>
        availableSnapshot
          ? withPluginMetadataSnapshotScope(availableSnapshot, collect, {
              config: coerceConfig(effectiveConfigRaw),
              env: deps.env,
            })
          : collect(),
      );
      // Invalid snapshots stay inspectable, but rejected env.vars must not become runtime state.
      restoreEnvChangesIfUnchanged({
        env: deps.env,
        before: envBeforeRead,
        after: snapshotEnv(deps.env),
      });
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
          exists: true,
          raw: snapshotRaw,
          parsed: snapshotParsed,
          includeProvenance,
          agentRosterIncludeOwned,
          bindingsIncludeOwned,
          sourceConfigBeforeMigrations: coerceConfig(readResolution.resolvedConfigRaw),
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: false,
          runtimeConfig: coerceConfig(effectiveConfigRaw),
          hash: snapshotHash,
          issues: validated.issues,
          warnings: [...validated.warnings, ...envVarWarnings],
          resolutionFacts: readResolution.resolutionFacts,
          legacyIssues,
        }),
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
        includeFileHashesForWrite,
        includeFileTargetsForWrite,
      });
    }
    if (!deps.suppressFutureVersionWarning) {
      warnIfConfigFromFuture(validated.config, deps.logger);
    }
    let callerRejectedSuspiciousRecovery = false;
    if (
      options.recoverSuspicious === true &&
      deps.observe &&
      !options.skipSuspiciousRecovery &&
      !containsConfigIncludeDirective(effectiveParsed)
    ) {
      const allowSuspiciousRecovery = options.allowSuspiciousRecovery;
      let recoveryCandidate: OpenClawConfig | null = null;
      const recovery = await deps.measure("config.snapshot.read.recover-suspicious", () =>
        maybeRecoverSuspiciousConfigRead({
          deps,
          configPath,
          raw,
          parsed: effectiveParsed,
          prepareBackup: (backup) => {
            const prepared = context.prepareRecoveryBackupCandidate(backup);
            recoveryCandidate = prepared.ok ? (prepared.candidate.config ?? null) : null;
            return prepared;
          },
          ...(allowSuspiciousRecovery
            ? {
                allowBackupRecovery: async () => {
                  const allowed =
                    recoveryCandidate !== null &&
                    (await allowSuspiciousRecovery(recoveryCandidate, validated.config));
                  callerRejectedSuspiciousRecovery = !allowed;
                  return allowed;
                },
              }
            : {}),
        }),
      );
      if (recovery.raw !== raw) {
        restoreEnvChangesIfUnchanged({
          env: deps.env,
          before: envBeforeRead,
          after: snapshotEnv(deps.env),
        });
        return await readConfigFileSnapshotInternal(context, {
          allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
          recoverSuspicious: options.recoverSuspicious,
          skipSuspiciousRecovery: true,
        });
      }
    }
    const snapshotConfig = await deps.measure("config.snapshot.read.materialize", () =>
      materializeRuntimeConfig(validated.config, {
        manifestRegistry:
          pluginMetadata.getSnapshot()?.manifestRegistry ??
          (context.options.pluginValidation === "core-only" ? { plugins: [] } : undefined),
      }),
    );
    return await deps.measure("config.snapshot.read.observe", () =>
      finalizeReadConfigSnapshotInternalResult(
        deps,
        {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            includeProvenance,
            agentRosterIncludeOwned,
            bindingsIncludeOwned,
            sourceConfigBeforeMigrations: coerceConfig(readResolution.resolvedConfigRaw),
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: true,
            runtimeConfig: snapshotConfig,
            hash: snapshotHash,
            issues: [],
            warnings: [...validated.warnings, ...envVarWarnings],
            resolutionFacts: readResolution.resolutionFacts,
            legacyIssues: [],
          }),
          envSnapshotForRestore: readResolution.envSnapshotForRestore,
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
          pluginMetadataSnapshot: pluginMetadata.getSnapshot(),
        },
        { observe: !callerRejectedSuspiciousRecovery },
      ),
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    let message: string;
    if (nodeError?.code === "EACCES") {
      const uid = process.getuid?.();
      const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
      message = [
        `read failed: ${String(error)}`,
        "",
        "Config file is not readable by the current process. If running in a container",
        "or 1-click deployment, fix ownership with:",
        `  chown ${uidHint} "${configPath}"`,
        "Then restart the gateway.",
      ].join("\n");
      deps.logger.error(message);
    } else {
      message = `read failed: ${String(error)}`;
    }
    return await finalizeReadConfigSnapshotInternalResult(deps, {
      snapshot: createConfigFileSnapshot({
        path: configPath,
        includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
        exists: true,
        raw: fallbackRaw,
        parsed: fallbackParsed,
        sourceConfig: fallbackSourceConfig,
        valid: false,
        runtimeConfig: fallbackSourceConfig,
        hash: fallbackHash,
        ...(fallbackRaw === null ? { readError: { code: nodeError?.code ?? null } } : {}),
        issues: [{ path: "", message }],
        warnings: [],
        legacyIssues: [],
      }),
      envSnapshotForRestore: fallbackEnvSnapshotForRestore,
      includeFileHashesForWrite,
      includeFileTargetsForWrite,
    });
  }
}

export async function readConfigFileSnapshotFromContext(
  context: ConfigIoContext,
  options: ConfigSnapshotReadOptions = {},
): Promise<ConfigFileSnapshot> {
  return (
    await readConfigFileSnapshotInternal(context, {
      recoverSuspicious: options.recoverSuspicious === true,
      allowSuspiciousRecovery: options.allowSuspiciousRecovery,
    })
  ).snapshot;
}

export async function readConfigFileSnapshotWithPluginMetadataFromContext(
  context: ConfigIoContext,
  options: ConfigSnapshotReadOptions = {},
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  const result = await readConfigFileSnapshotInternal(context, {
    allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    recoverSuspicious: options.recoverSuspicious === true,
    allowSuspiciousRecovery: options.allowSuspiciousRecovery,
  });
  let pluginMetadataSnapshot = result.pluginMetadataSnapshot;
  if (!pluginMetadataSnapshot && result.snapshot.valid) {
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw: result.snapshot.sourceConfig,
      env: context.deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    pluginMetadata.load(result.snapshot.sourceConfig);
    pluginMetadataSnapshot = pluginMetadata.getSnapshot();
  }
  return {
    snapshot: result.snapshot,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  };
}

export async function readConfigFileSnapshotForWriteFromContext(
  context: ConfigIoContext,
): Promise<ReadConfigFileSnapshotForWriteResult> {
  const assertConfigPathForWrite = () => {
    if (resolveConfigPathForDeps(context.deps) !== context.configPath) {
      throw new ConfigMutationConflictError("config path changed since last load", {
        retryable: false,
      });
    }
  };
  assertConfigPathForWrite();
  const result = await readConfigFileSnapshotInternal(context);
  assertConfigPathForWrite();
  return {
    snapshot: result.snapshot,
    writeOptions: {
      assertConfigPathForWrite,
      basePluginMetadataSnapshot: result.pluginMetadataSnapshot,
      envSnapshotForRestore: result.envSnapshotForRestore,
      expectedConfigPath: context.configPath,
      ownedConfigPathForWrite: context.configPath,
      includeFileHashesForWrite: result.includeFileHashesForWrite,
      includeFileTargetsForWrite: result.includeFileTargetsForWrite,
      unsetPaths: resolveManagedUnsetPathsForWrite(undefined),
    },
  };
}

export async function readBestEffortConfigSnapshotFromContext(
  context: ConfigIoContext,
): Promise<BestEffortConfigSnapshot> {
  const result = await readConfigFileSnapshotInternal(context);
  if (!result.snapshot.valid) {
    return {
      config: result.snapshot.config,
      sourceConfig: result.snapshot.sourceConfig,
      configDiagnostics: {
        path: result.snapshot.path,
        issues: result.snapshot.issues,
      },
    };
  }
  return {
    // The snapshot already materialized under the caller's plugin-validation policy.
    config: context.finalizeLoadedRuntimeConfig(result.snapshot.config),
    sourceConfig: result.snapshot.sourceConfig,
    configDiagnostics: null,
  };
}

export async function readSourceConfigBestEffortFromContext(
  context: ConfigIoContext,
): Promise<OpenClawConfig> {
  const { deps, configPath } = context;
  maybeLoadDotEnvForConfig(deps.env);
  if (!deps.fs.existsSync(configPath)) {
    return {};
  }
  // Best-effort legitimizes the fallback value, not the silence: consumers
  // (update-channel selection, doctor lint) act on the result, so each
  // degradation records why the real config was not used.
  try {
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    const parsed = parseConfigJson5(raw, deps.json5);
    if (!parsed.ok) {
      deps.logger.warn(
        `Config (${configPath}): best-effort read ignored unparseable config: ${parsed.error}`,
      );
      return {};
    }
    let resolved: unknown;
    try {
      resolved = resolveConfigIncludesForRead(parsed.parsed, configPath, deps);
    } catch (err) {
      deps.logger.warn(
        `Config (${configPath}): best-effort read skipped $include resolution: ${formatErrorMessage(err)}`,
      );
      return coerceConfig(parsed.parsed);
    }
    const resolution = resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv);
    return coerceConfig(resolution.resolvedConfigRaw);
  } catch (err) {
    deps.logger.warn(`Config (${configPath}): best-effort read failed: ${formatErrorMessage(err)}`);
    return {};
  }
}
