import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import type { ConfigIoContext } from "./io.context.js";
import { materializeConfigForLoad } from "./io.context.js";
import { throwInvalidConfig } from "./io.invalid-config.js";
import { maybeRecoverSuspiciousConfigReadSync } from "./io.observe-recovery.js";
import {
  coerceConfig,
  containsConfigIncludeDirective,
  hashConfigRaw,
  maybeLoadDotEnvForConfig,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import { createConfigFileSnapshot } from "./io.snapshot-shared.js";
import { loggedConfigWarningFingerprints, loggedInvalidConfigs } from "./io.state.js";
import {
  logConfigWarningsOnce,
  warnIfConfigFromFuture,
  warnOnConfigMiskeys,
} from "./io.warnings.js";
import { migratePersistedImplicitMainRoster } from "./legacy.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export function loadConfigFromContext(
  context: ConfigIoContext,
  options: { skipSuspiciousRecovery?: boolean } = {},
): OpenClawConfig {
  const { deps, configPath } = context;
  let envBeforeRead: Record<string, string | undefined> | undefined;
  try {
    maybeLoadDotEnvForConfig(deps.env);
    envBeforeRead = snapshotEnv(deps.env);
    if (!deps.fs.existsSync(configPath)) {
      loggedConfigWarningFingerprints.delete(configPath);
      if (
        context.options.shellEnvFallback !== "defer" &&
        shouldEnableShellEnvFallback(deps.env) &&
        !shouldDeferShellEnvFallback(deps.env)
      ) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: resolveShellEnvExpectedKeys(deps.env),
          logger: deps.logger,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }
      return {};
    }
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    const parsed = deps.json5.parse(raw);
    const readResolution = resolveConfigForRead(
      resolveConfigIncludesForRead(parsed, configPath, deps),
      deps.env,
      deps.lowerPrecedenceEnv,
    );
    const rosterMigration = migratePersistedImplicitMainRoster(readResolution.resolvedConfigRaw);
    const effectiveConfigRaw = rosterMigration.config;
    const validationConfigRaw = effectiveConfigRaw;
    const snapshotRaw = raw;
    const snapshotParsed = parsed;
    const hash = hashConfigRaw(snapshotRaw);
    for (const warning of readResolution.envWarnings) {
      deps.logger.warn(
        `Config (${configPath}): missing env var "${warning.varName}" at ${warning.configPath} - feature using this value will be unavailable`,
      );
    }
    for (const diagnostic of rosterMigration.diagnostics) {
      deps.logger.warn(`Config (${configPath}): ${diagnostic}`);
    }
    warnOnConfigMiskeys(validationConfigRaw, deps.logger);
    if (typeof validationConfigRaw !== "object" || validationConfigRaw === null) {
      loggedConfigWarningFingerprints.delete(configPath);
      context.observeLoadConfigSnapshot(
        createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: snapshotRaw,
          parsed: snapshotParsed,
          sourceConfig: {},
          valid: true,
          runtimeConfig: {},
          hash,
          issues: [],
          warnings: [],
          legacyIssues: [],
        }),
      );
      return {};
    }
    const duplicates = findDuplicateAgentDirs(validationConfigRaw as OpenClawConfig, {
      env: deps.env,
      homedir: deps.homedir,
    });
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw,
      env: deps.env,
    });
    const validated = validateConfigObjectWithPlugins(validationConfigRaw, {
      env: deps.env,
      pluginValidation: context.options.pluginValidation,
      loadPluginMetadataSnapshot: pluginMetadata.load,
      sourceRaw: snapshotParsed,
      preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
    });
    if (!validated.ok) {
      context.observeLoadConfigSnapshot(
        createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: snapshotRaw,
          parsed: snapshotParsed,
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: false,
          runtimeConfig: coerceConfig(effectiveConfigRaw),
          hash,
          issues: validated.issues,
          warnings: validated.warnings,
          legacyIssues: [],
        }),
      );
      throwInvalidConfig({
        configPath,
        issues: validated.issues,
        logger: deps.logger,
        loggedConfigPaths: loggedInvalidConfigs,
      });
    }
    if (context.options.pluginValidation !== "skip") {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    if (!deps.suppressFutureVersionWarning) {
      warnIfConfigFromFuture(validated.config, deps.logger);
    }
    if (
      deps.observe &&
      !options.skipSuspiciousRecovery &&
      !containsConfigIncludeDirective(parsed)
    ) {
      const recovery = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw,
        parsed,
        validateBackupSync: (backup) =>
          context.resolveSuspiciousRecoveryBackupCandidate(backup.parsed) !== null,
      });
      if (recovery.raw !== raw) {
        restoreEnvChangesIfUnchanged({
          env: deps.env,
          before: envBeforeRead,
          after: snapshotEnv(deps.env),
        });
        return loadConfigFromContext(context, { skipSuspiciousRecovery: true });
      }
    }
    const cfg = materializeConfigForLoad(
      context,
      validated.config,
      effectiveConfigRaw,
      pluginMetadata.getSnapshot(),
    );
    context.observeLoadConfigSnapshot(
      createConfigFileSnapshot({
        path: configPath,
        exists: true,
        raw: snapshotRaw,
        parsed: snapshotParsed,
        sourceConfig: coerceConfig(effectiveConfigRaw),
        valid: true,
        runtimeConfig: cfg,
        hash,
        issues: [],
        warnings: validated.warnings,
        legacyIssues: [],
      }),
    );
    return context.finalizeLoadedRuntimeConfig(cfg);
  } catch (error) {
    // Failed reads must not publish env.vars. The snapshot stays undefined only
    // when dotenv loading fails before config-owned environment mutation begins.
    if (envBeforeRead) {
      restoreEnvChangesIfUnchanged({
        env: deps.env,
        before: envBeforeRead,
        after: snapshotEnv(deps.env),
      });
    }
    if (error instanceof DuplicateAgentDirError) {
      deps.logger.error(error.message);
      throw error;
    }
    if ((error as { code?: string })?.code === "INVALID_CONFIG") {
      throw error;
    }
    deps.logger.error(`Failed to read config at ${configPath}`, error);
    throw error;
  }
}
