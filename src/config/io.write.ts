import type fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { isVerbose } from "../global-state.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { pinSurvivorWorkspaceForRosterCollapse } from "./agent-workspace-roster-transition.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { collectChangedPaths } from "./config-change-paths.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecord,
  restoreConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.js";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "./config-path-mutation.js";
import { getConfigValueAtPath, setConfigValueAtPath } from "./config-paths.js";
import {
  EnvRefArrayMutationError,
  restoreEnvRefsFromMap,
  restoreEnvVarRefs,
} from "./env-preserve.js";
import { INCLUDE_KEY, readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import {
  appendConfigAuditRecord,
  capConfigAuditIssues,
  capConfigAuditPaths,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import { prepareAuthInheritanceOwnerForWrite } from "./io.auth-inheritance-owner.js";
import type { ConfigIoContext } from "./io.context.js";
import { prepareCronOwnerWriteRefusal } from "./io.cron-owner-refusal.js";
import { recordConfigWriteMetadata } from "./io.meta.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";
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
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import type {
  ConfigWriteOptions,
  InternalConfigWriteResult,
  ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import { createConfigValidationFailedError } from "./io.write-errors.js";
import {
  preserveIncludeOwnedConfigForWrite,
  resolvePersistCandidateForWrite,
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
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveIncludeRoots } from "./paths.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import {
  materializeLegacyAgentOwnershipForActiveChannelsResult,
  validateConfigObjectRawWithPlugins,
} from "./validation.js";

function hasOwnIncludeDirective(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.hasOwn(value, INCLUDE_KEY);
}

function hasIncludedGatewayModeOwner(value: unknown): boolean {
  if (hasOwnIncludeDirective(value)) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const gateway = (value as Record<string, unknown>).gateway;
  if (hasOwnIncludeDirective(gateway)) {
    return true;
  }
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return false;
  }
  return hasOwnIncludeDirective((gateway as Record<string, unknown>).mode);
}

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
  let nextConfig = cfg;
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

  const sourceRosterMigration = migratePersistedImplicitMainRoster(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.parsed,
  );
  const retainedLegacyDefaultAgentId = sourceRosterMigration.retainedLegacyDefaultAgentId;
  const previousEntries = listAgentEntries(snapshot.config);
  const nextEntries = listAgentEntries(nextConfig);
  const nextAgentIds = new Set(nextEntries.map((entry) => normalizeAgentId(entry.id)));
  const previousSoleAgentId = tryResolveDefaultAgentId(snapshot.config);
  const entersMultiAgent = previousEntries.length <= 1 && nextEntries.length > 1;
  const previousSoleRemains = Boolean(
    previousSoleAgentId && nextAgentIds.has(normalizeAgentId(previousSoleAgentId)),
  );
  const writesOwnershipTopology =
    !isDeepStrictEqual(previousEntries, nextEntries) ||
    [...(options.explicitSetPaths ?? []), ...unsetPaths].some(
      (writePath) =>
        writePath[0] === "agents" &&
        (writePath.length === 1 ||
          writePath[1] === "entries" ||
          writePath[1] === "list" ||
          writePath[1] === "ownership"),
    );
  const persistOwnership =
    entersMultiAgent || (retainedLegacyDefaultAgentId !== undefined && writesOwnershipTopology);
  const keepOwnership = nextEntries.length > 1 && snapshot.config.agents?.ownership === "explicit";
  const stampOwnership =
    (persistOwnership || keepOwnership) && nextConfig.agents?.ownership === undefined;
  if (stampOwnership) {
    nextConfig = {
      ...nextConfig,
      agents: { ...nextConfig.agents, ownership: "explicit" },
    };
  }

  const workspaceCollapse = pinSurvivorWorkspaceForRosterCollapse(
    snapshot.config,
    nextConfig,
    deps.env,
  );
  nextConfig = workspaceCollapse.config;

  const authInheritanceOwnership = prepareAuthInheritanceOwnerForWrite({
    currentConfig: snapshot.config,
    targetConfig: nextConfig,
    writesOwnershipTopology,
    explicitSetPaths: options.explicitSetPaths,
    env: deps.env,
  });
  nextConfig = authInheritanceOwnership.config;

  const sessionStoreOwnership = prepareSessionStoreOwnershipForWrite({
    currentConfig: snapshot.config,
    currentStore: (snapshot.sourceConfigBeforeMigrations ?? snapshot.config).session?.store,
    targetConfig: nextConfig,
    env: deps.env,
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetValueSource,
  });
  nextConfig = sessionStoreOwnership.config;
  const { sameFixedSessionStore } = sessionStoreOwnership;
  const retainedFleetOwner =
    retainedLegacyDefaultAgentId &&
    writesOwnershipTopology &&
    nextAgentIds.has(normalizeAgentId(retainedLegacyDefaultAgentId))
      ? retainedLegacyDefaultAgentId
      : undefined;
  const ownerAgentId =
    (entersMultiAgent && previousSoleRemains ? previousSoleAgentId : undefined) ??
    retainedFleetOwner;
  const ownershipMaterialization = ownerAgentId
    ? materializeLegacyAgentOwnershipForActiveChannelsResult(
        nextConfig,
        ownerAgentId,
        deps.env,
        snapshotRead.pluginMetadataSnapshot?.manifestRegistry.plugins,
        { materializeSessionStore: sameFixedSessionStore, materializeWorkspace: true },
      )
    : { config: nextConfig, insertedPaths: [] as string[][] };
  nextConfig = ownershipMaterialization.config;
  const insertedPaths = [
    ...(persistOwnership || keepOwnership
      ? (sourceRosterMigration.insertedPaths ?? []).filter(
          (entry) =>
            sameFixedSessionStore || entry.join(".") !== "agents.defaults.sessionStore.agentId",
        )
      : []),
    ...((persistOwnership || keepOwnership) &&
    retainedLegacyDefaultAgentId &&
    Array.isArray(snapshot.config.bindings) &&
    !isDeepStrictEqual(snapshot.sourceConfigBeforeMigrations?.bindings, snapshot.config.bindings)
      ? [["bindings"]]
      : []),
    ...ownershipMaterialization.insertedPaths.concat(workspaceCollapse.insertedPaths),
    ...authInheritanceOwnership.insertedPaths, // Persisting explicit ownership must replace the authored legacy roster too.
    ...(persistOwnership ? [["agents", "entries"]] : []), // Otherwise projection restores the retired default marker.
    ...(stampOwnership ? [["agents", "ownership"]] : []),
  ];

  const nextSessionStoreConfig = nextConfig.agents?.defaults?.sessionStore;
  if (
    !ownerAgentId &&
    writesOwnershipTopology &&
    previousEntries.length === 1 &&
    previousSoleAgentId &&
    !previousSoleRemains &&
    sameFixedSessionStore &&
    (nextSessionStoreConfig === undefined ||
      (isRecord(nextSessionStoreConfig) && !Object.hasOwn(nextSessionStoreConfig, "agentId")))
  ) {
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          sessionStore: {
            ...(isRecord(nextSessionStoreConfig) ? nextSessionStoreConfig : {}),
            agentId: normalizeAgentId(previousSoleAgentId),
          },
        },
      },
    };
    insertedPaths.push(["agents", "defaults", "sessionStore", "agentId"]);
  }

  const topologyPaths = [
    ...new Map(insertedPaths.map((entry) => [entry.join("\0"), entry])).values(),
  ];
  assertAutomaticBindingsWriteAllowed({
    bindingsIncludeOwned: snapshot.bindingsIncludeOwned === true,
    ownershipPaths: topologyPaths,
  });
  const explicitSetPaths = [...(options.explicitSetPaths ?? []), ...topologyPaths];
  const explicitSetValueSource = structuredClone(
    options.explicitSetValueSource ?? nextConfig,
  ) as Record<string, unknown>;
  for (const ownershipPath of topologyPaths) {
    setConfigValueAtPath(
      explicitSetValueSource,
      ownershipPath,
      getConfigValueAtPath(nextConfig as Record<string, unknown>, ownershipPath),
    );
  }
  const cronOwnerRefusal = persistOwnership
    ? await prepareCronOwnerWriteRefusal(snapshot.config, {
        storePath: resolveCronJobsStorePathFromConfig(nextConfig, deps.env),
        ...(retainedFleetOwner ? { provenOwnerAgentId: retainedFleetOwner } : {}),
        env: deps.env,
      })
    : undefined;

  let persistCandidate: unknown = nextConfig;
  let envRefMap: Map<string, string> | null = null;
  const changedPaths = new Set<string>();
  collectChangedPaths(snapshot.config, nextConfig, "", changedPaths);
  for (const changedPath of [...explicitSetPaths, ...(options.unsetPaths ?? [])]) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  const identityRestoredPaths = new Set<string>();
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  const hasIncludes = hasAuthoredIncludes && !containsConfigIncludeDirective(snapshot.sourceConfig);
  // Missing snapshots still need runtime-to-authored projection. Callers authoring an
  // exact bootstrap roster mark that intent through explicitSetPaths.
  if (snapshot.valid) {
    persistCandidate = resolvePersistCandidateForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      nextConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      unsetPaths,
      explicitSetPaths,
      explicitSetValueSource,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
      preserveLegacyAgentRoster: Boolean(retainedLegacyDefaultAgentId) && !writesOwnershipTopology,
    });
  } else if (snapshot.exists && hasAuthoredIncludes) {
    persistCandidate = preserveIncludeOwnedConfigForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      nextConfig,
      rootAuthoredConfig: snapshot.parsed,
    });
  }
  if (snapshot.exists && (snapshot.valid || hasIncludes)) {
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
    semanticValidation: "strict",
    pluginMetadataSnapshot: snapshotRead.pluginMetadataSnapshot,
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
  });
  if (!validated.ok) {
    throw createConfigValidationFailedError(validated.issues);
  }
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);
  // Capture before commit so rollback cannot restore a watcher-updated slot.
  const priorSnapshotAuditRecord = readLatestConfigSnapshotAuditRecord({
    env: deps.env,
    homedir: deps.homedir,
  });

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
  const outputConfigBase = envRefMap
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
  const stampedOutputConfig = stampConfigVersion(
    outputConfig,
    options.lastTouchedVersionOverride,
    snapshot.exists ? snapshot.parsed : null,
  );
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = resolveConfigSnapshotHash(snapshot);
  const changedPathCount = changedPaths.size;
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
  const authoredGateway = (snapshot.parsed as { gateway?: unknown }).gateway;
  const authoredGatewayMode =
    authoredGateway !== null &&
    typeof authoredGateway === "object" &&
    !Array.isArray(authoredGateway)
      ? (authoredGateway as Record<string, unknown>).mode
      : undefined;
  const gatewayModeAuthoredLocally =
    authoredGateway !== null &&
    typeof authoredGateway === "object" &&
    !Array.isArray(authoredGateway) &&
    Object.hasOwn(authoredGateway, "mode") &&
    !hasOwnIncludeDirective(authoredGatewayMode);
  const preservesIncludedGatewayMode =
    options.allowIncludeAncestorExplicitSetPaths === true &&
    gatewayModeBefore != null &&
    !gatewayModeAuthoredLocally &&
    hasIncludedGatewayModeOwner(stampedOutputConfig) &&
    !options.explicitSetPaths?.some((explicitPath) => explicitPath[0] === "gateway");
  const gatewayModeAfter =
    resolveGatewayMode(stampedOutputConfig) ??
    (preservesIncludedGatewayMode ? gatewayModeBefore : null) ??
    null;
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  const readTestLogFlag = (name: string) => isVitestRuntimeEnv(deps.env) && deps.env[name] === "1";
  const logConfigOverwrite = () => {
    if (
      !snapshot.exists ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG"))
    ) {
      return;
    }
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
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
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (
      suspiciousReasons.length === 0 ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !testLog)
    ) {
      return;
    }
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
    changedPaths: [...changedPaths],
    origin: options.auditOrigin,
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
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(stampedOutputConfig);
  await preCommitRuntimePreflight(sourceConfigForPreflight);

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
        await cronOwnerRefusal?.recheck();
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
    try {
      options.assertConfigPathForWrite?.();
    } catch (error) {
      try {
        await rollbackConfigFileWriteIfUnchanged({
          configPath,
          previousSnapshot: snapshot,
          committedHash: nextHash,
          fsModule: deps.fs,
        });
      } catch (rollbackError) {
        throw new ConfigRuntimeRefreshError(
          `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      recordConfigWriteMetadata(new Date().toISOString(), options.lastTouchedVersionOverride);
    } catch (error) {
      deps.logger.warn(`Config metadata state update failed: ${formatErrorMessage(error)}`);
    }
    logConfigOverwrite();
    logConfigWriteAnomalies();
    await appendWriteAudit(
      result.method,
      undefined,
      await deps.fs.promises.stat(configPath).catch(() => null),
    );
    if (
      configSnapshotAuditRecordMatchesPath(priorSnapshotAuditRecord, configPath) &&
      priorSnapshotAuditRecord.rawHash !== previousHash
    ) {
      const offlineChangedPaths = new Set<string>();
      collectChangedPaths(
        priorSnapshotAuditRecord.fingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, {
          env: deps.env,
          homedir: deps.homedir,
        }),
        "",
        offlineChangedPaths,
      );
      await appendConfigAuditRecord({
        env: deps.env,
        homedir: deps.homedir,
        record: {
          ts: new Date().toISOString(),
          source: "config-io",
          event: "config.external",
          detectedBy: "write",
          configPath,
          previousHash: priorSnapshotAuditRecord.rawHash,
          nextHash: previousHash ?? null,
          valid: snapshot.valid,
          ...(snapshot.valid
            ? offlineChangedPaths.size > 0
              ? { changedPaths: capConfigAuditPaths([...offlineChangedPaths]) }
              : { opaqueChange: true }
            : {
                issues: capConfigAuditIssues(
                  formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }),
                ),
              }),
        },
      });
    }
    const writtenSnapshotAuditRecord = upsertConfigSnapshotAuditRecord({
      env: deps.env,
      homedir: deps.homedir,
      configPath,
      rawHash: nextHash,
      authoredConfig: stampedOutputConfig,
      expectedSnapshot: priorSnapshotAuditRecord,
    });
    if (!options.skipPluginValidation) {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    return {
      persistedHash: nextHash,
      persistedConfig: stampedOutputConfig,
      [configWritePostCommitRollback]: () => {
        restoreConfigSnapshotAuditRecord({
          env: deps.env,
          homedir: deps.homedir,
          snapshot: priorSnapshotAuditRecord,
          expectedSnapshot: writtenSnapshotAuditRecord,
        });
        if (previousWarningFingerprint === undefined) {
          loggedConfigWarningFingerprints.delete(configPath);
        } else {
          setBoundedConfigIoWarningEntry(
            loggedConfigWarningFingerprints,
            configPath,
            previousWarningFingerprint,
          );
        }
      },
    };
  } catch (error) {
    await appendWriteAudit("failed", error);
    throw error;
  }
}
