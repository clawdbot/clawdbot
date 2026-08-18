/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import {
  parseConfigJson5,
  preserveConfigSnapshotAsClobbered,
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveCanonicalConfigPath } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import {
  migrationCheckpointIdentitiesMatch,
  resolveMigrationCheckpointIdentity,
} from "./doctor-config-preflight-checkpoint.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  needsRefreshedPluginIndexPersistence,
  persistRefreshedPluginIndex,
  readDoctorConfigPreflightSnapshot,
  type DoctorConfigPreflightPluginSnapshotRead,
} from "./doctor-config-preflight-plugin-index.js";
import {
  formatStartupPluginVerificationFailure,
  refreshStartupPluginQuarantine,
  runStartupUpgradeConvergence,
} from "./doctor-config-preflight-plugin-verification.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import {
  formatStartupMigrationFailure,
  refuseStartupMigrationsForLiveGatewayOwner,
  throwStartupMigrationGuardRejected,
  throwStartupMigrationIdentityChanged,
  throwStartupMigrationRefusal,
} from "./doctor-startup-migration-refusal.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";

const loadDoctorStateMigrations = createLazyRuntimeModule(
  () => import("./doctor-state-migrations.js"),
);

const loadLegacyCronRepair = createLazyRuntimeModule(
  () => import("./doctor/cron/legacy-repair.js"),
);

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetPath = resolveCanonicalConfigPath();
  const targetDir = path.dirname(targetPath);
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch (err) {
    // EEXIST means a config already lives at the target — nothing to migrate.
    // Any other failure (EACCES, ENOSPC) must surface: doctor would otherwise
    // proceed as a fresh install while the operator's legacy config exists.
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "EEXIST") {
      throw new Error(
        `Failed to migrate legacy config ${legacyPath} -> ${targetPath}: ${formatErrorMessage(err)}`,
        { cause: err },
      );
    }
  }

  return changes;
}

export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  cronCodexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
};

/** Returns true during updater-managed config rewrites where plugin validation may be stale. */
export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

function noteStateMigrationResult(result: {
  changes: string[];
  warnings: string[];
  notices?: string[];
}): void {
  if (result.changes.length > 0) {
    note(result.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = result.notices ?? [];
  if (notices.length > 0) {
    note(notices.map((entry) => `- ${entry}`).join("\n"), "Doctor notices");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }
}

/**
 * Runs early doctor config checks before the main config repair flow.
 *
 * It may migrate legacy state/config paths, recover corrupt target config when requested, and
 * returns the best-effort config snapshot used by later doctor checks.
 */
export async function runDoctorConfigPreflight(
  options: {
    migrateState?: boolean;
    migrateLegacyConfig?: boolean;
    repairPrefixedConfig?: boolean;
    recoverCorruptTargetStore?: boolean;
    invalidConfigNote?: string | false;
    observe?: boolean;
    measure?: ConfigSnapshotReadMeasure;
    /** Return false or reject on config drift; the preflight always unwinds owned resources. */
    beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
    requireStateMigrationCheckpoint?: boolean;
    requireStartupMigrationCheckpoint?: boolean;
    /** Load one authoritative plugin metadata snapshot for the caller's full lifecycle. */
    preparePluginMetadataSnapshot?: boolean;
    /** Core state was proven absent before Gateway selection could create runtime files. */
    skipPristineCoreStateMigrations?: boolean;
    /** Prepared before Gateway bootstrap can create files under an otherwise pristine state root. */
    skipPristineStartupStateMigrations?: boolean;
    /** Parsed CLI owner for automatic agent/session migration only. */
    stateMigrationAgentId?: string;
    /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
    doctorOnlyStateMigrations?: boolean;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  const stateMigrationsRequested = options.migrateState !== false;
  const gatewayStartupCheckpointRequired = options.requireStartupMigrationCheckpoint === true;
  if (gatewayStartupCheckpointRequired) {
    // First preflight operation: state write admission below already quarantines orphaned
    // SQLite sidecars, so the live-owner refusal must precede every mutation-capable step.
    await refuseStartupMigrationsForLiveGatewayOwner(process.env);
  }
  if (stateMigrationsRequested) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      env: process.env,
    });
  }
  const measurePreflightStep = <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure);
  const migrationCheckpointRequired =
    gatewayStartupCheckpointRequired || options.requireStateMigrationCheckpoint === true;
  let migrationCheckpoint = migrationCheckpointRequired
    ? await measurePreflightStep(
        "startup-checkpoint-import",
        () => import("../infra/startup-migration-checkpoint.js"),
      )
    : undefined;
  let stateMigrations: Awaited<ReturnType<typeof loadDoctorStateMigrations>> | undefined;
  let startupMigrationEnv = process.env;
  let shouldRecordStateCheckpoint = false;
  let shouldRecordStartupCheckpoint = false;
  let shouldPersistRefreshedPluginIndex: boolean;
  let migrationCheckpointIdentity: MigrationCheckpointIdentity | null = null;
  let skipPristineStartupStateMigrations = options.skipPristineStartupStateMigrations === true;
  let skipPristineCoreStateMigrations =
    skipPristineStartupStateMigrations || options.skipPristineCoreStateMigrations === true;
  let startupMigrationLease: StartupMigrationLease | undefined;
  let startupMigrationHeartbeat: ReturnType<typeof setInterval> | undefined;
  let startupMigrationHeartbeatError: unknown;
  const startupMigrationWarnings: string[] = [];
  const cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[] = [];
  let doctorMediaPersistenceAttempted = false;
  let legacyConfigMigrationComplete = false;
  let configSnapshotRead: DoctorConfigPreflightPluginSnapshotRead | undefined;
  const { run: runWithPluginMetadataSnapshot } = createDoctorPluginMetadataSnapshotScope({
    getBaseSnapshot: () => configSnapshotRead?.pluginMetadataSnapshot,
    env: process.env,
  });
  const ensureStartupMigrationLease = async () => {
    if (startupMigrationLease || !migrationCheckpoint) {
      return;
    }
    if (gatewayStartupCheckpointRequired) {
      // Re-probe past the entry gate: the lease wait below can block behind a sibling
      // startup that becomes the live owner before our migrations would mutate its state.
      await refuseStartupMigrationsForLiveGatewayOwner(startupMigrationEnv);
    }
    startupMigrationLease = await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({
      env: startupMigrationEnv,
    });
    // Another process may have completed the same work between our pre-lease read and acquisition.
    // Refresh every checkpoint input under the lease so only work still missing from state runs.
    configSnapshotRead = await readConfigSnapshotForPreflight();
    const latestBaseConfig =
      configSnapshotRead.snapshot.sourceConfig ?? configSnapshotRead.snapshot.config ?? {};
    migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
      snapshot: configSnapshotRead.snapshot,
      baseConfig: latestBaseConfig,
      pluginMigrationFingerprint: configSnapshotRead.pluginMigrationFingerprint,
    });
    shouldRecordStateCheckpoint =
      stateMigrationsRequested &&
      migrationCheckpoint.needsStateMigrationCheckpoint({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
      });
    shouldRecordStartupCheckpoint =
      gatewayStartupCheckpointRequired &&
      migrationCheckpoint.needsStartupMigrationCheckpoint({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
      });
    shouldPersistRefreshedPluginIndex = needsRefreshedPluginIndexPersistence(configSnapshotRead);
    if (
      !shouldRecordStateCheckpoint &&
      !shouldRecordStartupCheckpoint &&
      !shouldPersistRefreshedPluginIndex
    ) {
      startupMigrationLease.release();
      startupMigrationLease = undefined;
      return;
    }
    startupMigrationHeartbeat = setInterval(() => {
      try {
        startupMigrationLease?.heartbeat();
      } catch (error) {
        startupMigrationHeartbeatError = error;
      }
    }, 60_000);
    startupMigrationHeartbeat.unref?.();
  };
  const noteStartupStateMigrationResult = (result: {
    changes: string[];
    warnings: string[];
    notices?: string[];
  }) => {
    startupMigrationWarnings.push(...result.warnings);
    noteStateMigrationResult(result);
  };
  const migrateLegacyConfigIfNeeded = async () => {
    if (legacyConfigMigrationComplete) {
      return;
    }
    legacyConfigMigrationComplete = true;
    if (options.migrateLegacyConfig === false) {
      return;
    }
    const legacyConfigChanges = await measurePreflightStep(
      "legacy-config-migration",
      maybeMigrateLegacyConfig,
    );
    if (legacyConfigChanges.length > 0) {
      note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
  };
  const readConfigSnapshotForPreflight = async (allowCurrentPluginMetadata = true) =>
    await measurePreflightStep("config-snapshot", () =>
      readDoctorConfigPreflightSnapshot({
        allowCurrentPluginMetadata,
        includePluginMetadata:
          Boolean(migrationCheckpoint) || options.preparePluginMetadataSnapshot === true,
        measure: options.measure,
        observe: options.observe,
        preparePluginMetadataSnapshot: options.preparePluginMetadataSnapshot === true,
        skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
      }),
    );
  try {
    if (migrationCheckpoint && !skipPristineStartupStateMigrations) {
      // Capture pristine state before command bootstrap can prepare runtime state.
      const { planPristineStartupStateMigrations } = await measurePreflightStep(
        "pristine-state-plan-import",
        () => import("./doctor/shared/pristine-startup-state.js"),
      );
      const pristineStatePlan = await measurePreflightStep("pristine-state-plan", () =>
        planPristineStartupStateMigrations(process.env),
      );
      skipPristineStartupStateMigrations = pristineStatePlan.skipAllStateMigrations;
      skipPristineCoreStateMigrations ||= pristineStatePlan.skipCoreStateMigrations;
    }
    if (skipPristineStartupStateMigrations && !gatewayStartupCheckpointRequired) {
      // A pristine non-Gateway command has nothing to checkpoint. Leave the state root absent
      // until command execution reaches a real state consumer.
      migrationCheckpoint = undefined;
    }
    // The gateway uses this last-moment guard to ensure its prepared config did not change before
    // any automatic migration mutates state. A rejected guard skips every state migration stage.
    const stateMigrationsAllowed =
      !stateMigrationsRequested ||
      options.beforeStateMigrations === undefined ||
      (await measurePreflightStep("state-migration-guard", () =>
        options.beforeStateMigrations?.(),
      ));
    if (gatewayStartupCheckpointRequired && !stateMigrationsAllowed) {
      throwStartupMigrationGuardRejected();
    }
    if (migrationCheckpoint) {
      await migrateLegacyConfigIfNeeded();
      configSnapshotRead = await readConfigSnapshotForPreflight();
      const initialBaseConfig =
        configSnapshotRead.snapshot.sourceConfig ?? configSnapshotRead.snapshot.config ?? {};
      migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
        snapshot: configSnapshotRead.snapshot,
        baseConfig: initialBaseConfig,
        pluginMigrationFingerprint: configSnapshotRead.pluginMigrationFingerprint,
      });
      // Later config reads can apply state selectors. Pin the accepted lease target for its lifetime.
      startupMigrationEnv = cloneEnvWithPlatformSemantics(process.env);
      shouldRecordStateCheckpoint =
        stateMigrationsRequested &&
        migrationCheckpoint.needsStateMigrationCheckpoint({
          env: startupMigrationEnv,
          identity: migrationCheckpointIdentity,
        });
      shouldRecordStartupCheckpoint =
        gatewayStartupCheckpointRequired &&
        migrationCheckpoint.needsStartupMigrationCheckpoint({
          env: startupMigrationEnv,
          identity: migrationCheckpointIdentity,
        });
      shouldPersistRefreshedPluginIndex = needsRefreshedPluginIndexPersistence(configSnapshotRead);
      if (
        shouldRecordStateCheckpoint ||
        shouldRecordStartupCheckpoint ||
        shouldPersistRefreshedPluginIndex
      ) {
        await ensureStartupMigrationLease();
      }
    }
    // A current state checkpoint proves this root already completed every automatic migration.
    // Keep repeated short-lived commands out of the legacy migration import graph.
    stateMigrations =
      stateMigrationsRequested &&
      (!migrationCheckpoint || shouldRecordStateCheckpoint) &&
      !skipPristineStartupStateMigrations
        ? await measurePreflightStep("state-migrations-import", loadDoctorStateMigrations)
        : undefined;
    if (stateMigrations && stateMigrationsAllowed) {
      const { autoMigrateLegacyStateDir } = stateMigrations;
      const stateDirResult = await measurePreflightStep("state-dir-migrations", () =>
        autoMigrateLegacyStateDir({ env: process.env }),
      );
      noteStartupStateMigrationResult(stateDirResult);
    }

    await migrateLegacyConfigIfNeeded();
    if (!configSnapshotRead || stateMigrations) {
      // Legacy state migration can move the persisted plugin index into the canonical state root.
      // Re-read before config-dependent migrations so their checkpoint names that final inventory.
      configSnapshotRead = await readConfigSnapshotForPreflight();
    }

    let snapshot = configSnapshotRead.snapshot;
    if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
      if (await recoverConfigFromJsonRootSuffix(snapshot)) {
        note(
          "Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.",
          "Config",
        );
        configSnapshotRead = await readConfigSnapshotForPreflight();
        snapshot = configSnapshotRead.snapshot;
      } else if (
        await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" })
      ) {
        note(
          "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
          "Config",
        );
        configSnapshotRead = await readConfigSnapshotForPreflight();
        snapshot = configSnapshotRead.snapshot;
      }
      if (
        !snapshot.valid &&
        typeof snapshot.raw === "string" &&
        !parseConfigJson5(snapshot.raw).ok
      ) {
        const clobberedPath = await preserveConfigSnapshotAsClobbered(snapshot);
        if (!clobberedPath) {
          throw new Error(
            `Config could not be parsed or recovered, and doctor could not preserve a .clobbered snapshot. The original remains unchanged at ${snapshot.path}; refusing to apply repairs.`,
          );
        }
        throw new Error(
          `Config could not be parsed or recovered. Original preserved at ${clobberedPath}. The current file remains unchanged; refusing to apply repairs.`,
        );
      }
    }
    const invalidConfigNote =
      options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
    if (
      invalidConfigNote &&
      snapshot.exists &&
      !snapshot.valid &&
      snapshot.legacyIssues.length === 0
    ) {
      note(invalidConfigNote, "Config");
      noteIncludeConfinementWarning(snapshot);
    }

    const warnings = snapshot.warnings ?? [];
    if (warnings.length > 0) {
      note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
    }

    const baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    const stateMigrationInput = resolveStateMigrationConfigInput({
      snapshot,
      baseConfig,
      stateMigrationAgentId: options.stateMigrationAgentId,
    });
    if (migrationCheckpoint) {
      migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
        snapshot,
        baseConfig,
        pluginMigrationFingerprint: configSnapshotRead.pluginMigrationFingerprint,
      });
    }
    shouldPersistRefreshedPluginIndex =
      migrationCheckpoint !== undefined && needsRefreshedPluginIndexPersistence(configSnapshotRead);
    if (shouldPersistRefreshedPluginIndex) {
      await ensureStartupMigrationLease();
    }
    const freshConfigGuardRequired =
      stateMigrations !== undefined ||
      shouldRecordStateCheckpoint ||
      shouldRecordStartupCheckpoint ||
      shouldPersistRefreshedPluginIndex;
    const freshConfigGuardAllowed =
      !freshConfigGuardRequired ||
      !stateMigrationsAllowed ||
      options.beforeStateMigrations === undefined ||
      (await measurePreflightStep("fresh-config-guard", () =>
        options.beforeStateMigrations?.(snapshot),
      ));
    if (gatewayStartupCheckpointRequired && !freshConfigGuardAllowed) {
      throwStartupMigrationGuardRejected();
    }
    if (stateMigrations && stateMigrationsAllowed && freshConfigGuardAllowed) {
      const {
        autoMigrateLegacyState,
        autoMigrateLegacyPluginDoctorState,
        autoMigrateLegacyTaskStateSidecars,
        migrateLegacyConfigMachineState,
      } = stateMigrations;
      if (stateMigrationInput) {
        const pluginDoctorOnlyConfig =
          stateMigrationInput.pluginDoctorConfig ?? stateMigrationInput.cfg;
        // Retired cron.store selects a persisted SQLite partition. Preserve it in machine state
        // before config repair removes the only custom-partition evidence.
        if (
          skipPristineCoreStateMigrations &&
          pluginDoctorOnlyConfig &&
          !cronMigration.retainStoreConfig(pluginDoctorOnlyConfig)
        ) {
          // Core state is absent, but plugin paths may own external migration state.
          // Keep their doctor owner active without loading channel/session detectors.
          noteStartupStateMigrationResult(
            await measurePreflightStep("plugin-doctor-migrations", () =>
              runWithPluginMetadataSnapshot({ config: pluginDoctorOnlyConfig }, () =>
                autoMigrateLegacyPluginDoctorState({
                  config: pluginDoctorOnlyConfig,
                  env: process.env,
                  ...(options.doctorOnlyStateMigrations === true
                    ? { doctorOnlyStateMigrations: true }
                    : {}),
                }),
              ),
            ),
          );
        } else if (stateMigrationInput.cfg) {
          const migrationConfig = stateMigrationInput.cfg;
          const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
          const {
            collectCronCodexRuntimePolicyTargetsReadOnly,
            repairLegacyCronStoreWithoutPrompt,
          } = await measurePreflightStep("cron-repair-import", loadLegacyCronRepair);
          const cronResult = await measurePreflightStep("cron-repair", () =>
            repairLegacyCronStoreWithoutPrompt({
              cfg: cronMigration.withLegacyConfig(migrationConfig, pluginDoctorConfig),
              migrateCodexModelRefs: false,
            }),
          );
          noteStartupStateMigrationResult(cronResult);
          if (options.repairPrefixedConfig === true) {
            const cronCodexPlan = await measurePreflightStep("cron-policy-scan", () =>
              collectCronCodexRuntimePolicyTargetsReadOnly({
                cfg: migrationConfig,
              }),
            );
            cronCodexRuntimePolicyTargets.push(...cronCodexPlan.targets);
            noteStartupStateMigrationResult({ changes: [], warnings: cronCodexPlan.warnings });
          }
          const legacyStateResult = await measurePreflightStep("legacy-state-migrations", () =>
            runWithPluginMetadataSnapshot({ config: pluginDoctorConfig ?? migrationConfig }, () =>
              autoMigrateLegacyState({
                cfg: migrationConfig,
                ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
                env: process.env,
                recoverCorruptTargetStore: options.recoverCorruptTargetStore,
                doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
              }),
            ),
          );
          doctorMediaPersistenceAttempted = options.doctorOnlyStateMigrations === true;
          noteStartupStateMigrationResult(legacyStateResult);
        } else if (stateMigrationInput.pluginDoctorConfig) {
          const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
          const cronMigrationConfig = cronMigration.retainStoreConfig(pluginDoctorConfig);
          if (cronMigrationConfig) {
            // A partially valid config cannot drive general core migrations, but its retired
            // cron.store is still the sole authority for selecting and preserving that partition.
            const { repairLegacyCronStoreWithoutPrompt } = await measurePreflightStep(
              "cron-repair-import",
              loadLegacyCronRepair,
            );
            noteStartupStateMigrationResult(
              await measurePreflightStep("cron-repair", () =>
                repairLegacyCronStoreWithoutPrompt({
                  cfg: cronMigrationConfig,
                  migrateCodexModelRefs: false,
                }),
              ),
            );
            noteStartupStateMigrationResult(
              migrateLegacyConfigMachineState({ config: pluginDoctorConfig, env: process.env }),
            );
          }
          noteStartupStateMigrationResult(
            await measurePreflightStep("plugin-doctor-migrations", () =>
              runWithPluginMetadataSnapshot({ config: pluginDoctorConfig }, () =>
                autoMigrateLegacyPluginDoctorState({
                  config: pluginDoctorConfig,
                  env: process.env,
                  ...(options.doctorOnlyStateMigrations === true
                    ? { doctorOnlyStateMigrations: true }
                    : {}),
                }),
              ),
            ),
          );
          noteStartupStateMigrationResult(
            await measurePreflightStep("task-sidecar-migrations", () =>
              autoMigrateLegacyTaskStateSidecars({
                env: process.env,
              }),
            ),
          );
        }
      } else {
        noteStartupStateMigrationResult(
          await measurePreflightStep("task-sidecar-migrations", () =>
            autoMigrateLegacyTaskStateSidecars({
              env: process.env,
            }),
          ),
        );
      }
    }
    if (
      stateMigrations &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      options.doctorOnlyStateMigrations === true &&
      !doctorMediaPersistenceAttempted
    ) {
      const activeStateMigrations = stateMigrations;
      noteStartupStateMigrationResult(
        await measurePreflightStep("media-persistence-migration", () =>
          activeStateMigrations.migrateLegacyMediaPersistence({ env: process.env }),
        ),
      );
    }
    if (
      shouldPersistRefreshedPluginIndex &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      startupMigrationWarnings.length === 0 &&
      snapshot.valid
    ) {
      const persistedSnapshotRead = await persistRefreshedPluginIndex({
        env: startupMigrationEnv,
        lease: startupMigrationLease,
        measure: measurePreflightStep,
        readPersistedSnapshot: () => readConfigSnapshotForPreflight(false),
        snapshotRead: configSnapshotRead,
      });
      const persistedBaseConfig =
        persistedSnapshotRead.snapshot.sourceConfig ?? persistedSnapshotRead.snapshot.config ?? {};
      const persistedIdentity = resolveMigrationCheckpointIdentity({
        snapshot: persistedSnapshotRead.snapshot,
        baseConfig: persistedBaseConfig,
        pluginMigrationFingerprint: persistedSnapshotRead.pluginMigrationFingerprint,
      });
      if (
        !migrationCheckpointIdentity ||
        !persistedIdentity ||
        migrationCheckpointIdentity.effectiveConfigFingerprint !==
          persistedIdentity.effectiveConfigFingerprint ||
        migrationCheckpointIdentity.pluginDoctorConfigFingerprint !==
          persistedIdentity.pluginDoctorConfigFingerprint
      ) {
        throw new Error(
          'OpenClaw config identity changed while persisting the refreshed plugin registry; refusing to write the migration checkpoint. Run "openclaw doctor --fix" and retry.',
        );
      }
      // The persisted reread is the only inventory mutation in preflight. Replace both the
      // authoritative snapshot and every fact derived from it at that boundary.
      configSnapshotRead = persistedSnapshotRead;
      migrationCheckpointIdentity = persistedIdentity;
    }
    if (
      (shouldRecordStateCheckpoint || shouldRecordStartupCheckpoint) &&
      startupMigrationHeartbeatError
    ) {
      throw startupMigrationHeartbeatError instanceof Error
        ? startupMigrationHeartbeatError
        : new Error("OpenClaw startup migration lease heartbeat failed.");
    }
    if (
      shouldRecordStateCheckpoint &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      startupMigrationWarnings.length === 0 &&
      snapshot.valid
    ) {
      if (!migrationCheckpoint) {
        throw new Error("OpenClaw state migration checkpoint module was not loaded.");
      }
      migrationCheckpoint.recordSuccessfulStateMigrations({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
        lease: startupMigrationLease,
      });
    }
    if (gatewayStartupCheckpointRequired) {
      if (startupMigrationWarnings.length > 0) {
        throwStartupMigrationRefusal(
          formatStartupMigrationFailure({
            warnings: startupMigrationWarnings,
            blockers: [],
          }),
        );
      }
      if (shouldRecordStartupCheckpoint && !snapshot.valid) {
        throwStartupMigrationRefusal(
          formatStartupMigrationFailure({
            warnings: [],
            blockers: ['OpenClaw config is invalid; run "openclaw doctor --fix" before startup.'],
          }),
        );
      }
      // This state is established before the first Gateway plugin load and remains
      // fixed for the boot. Refresh it on every process start because migration
      // checkpoints do not persist plugin availability or quarantine state.
      setActiveDegradedPlugins([]);
      if (snapshot.valid) {
        const pluginConvergence = shouldRecordStartupCheckpoint
          ? await runStartupUpgradeConvergence({
              cfg: baseConfig,
              env: process.env,
              ...(options.measure ? { measure: options.measure } : {}),
            })
          : await refreshStartupPluginQuarantine({
              cfg: baseConfig,
              env: process.env,
              ...(options.measure ? { measure: options.measure } : {}),
            });
        setActiveDegradedPlugins(pluginConvergence.quarantinedPlugins);
        if (pluginConvergence.blockingDiagnostic) {
          throwStartupMigrationRefusal(
            formatStartupPluginVerificationFailure(pluginConvergence.blockingDiagnostic),
          );
        }
        if (shouldRecordStartupCheckpoint) {
          const convergedSnapshotRead = await readConfigSnapshotForPreflight(false);
          const convergedBaseConfig =
            convergedSnapshotRead.snapshot.sourceConfig ??
            convergedSnapshotRead.snapshot.config ??
            {};
          const convergedIdentity = resolveMigrationCheckpointIdentity({
            snapshot: convergedSnapshotRead.snapshot,
            baseConfig: convergedBaseConfig,
            pluginMigrationFingerprint: convergedSnapshotRead.pluginMigrationFingerprint,
          });
          if (!migrationCheckpointIdentitiesMatch(migrationCheckpointIdentity, convergedIdentity)) {
            throwStartupMigrationIdentityChanged();
          }
        }
      }
    }
    if (shouldRecordStartupCheckpoint) {
      if (!migrationCheckpoint) {
        throw new Error("OpenClaw startup migration checkpoint module was not loaded.");
      }
      migrationCheckpoint.recordSuccessfulStartupMigrations({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
        lease: startupMigrationLease,
      });
    }

    return {
      snapshot,
      baseConfig,
      ...(configSnapshotRead.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: configSnapshotRead.pluginMetadataSnapshot }
        : {}),
      ...(cronCodexRuntimePolicyTargets.length > 0 ? { cronCodexRuntimePolicyTargets } : {}),
    };
  } finally {
    if (startupMigrationHeartbeat) {
      clearInterval(startupMigrationHeartbeat);
    }
    startupMigrationLease?.release();
  }
}
