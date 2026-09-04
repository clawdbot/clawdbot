/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import {
  parseConfigJson5,
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { logConfigWarningsOnce } from "../config/io.warnings.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import { resolveMigrationCheckpointIdentity } from "./doctor-config-preflight-checkpoint.js";
import { maybeMigrateLegacyConfig } from "./doctor-config-preflight-legacy-config.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  needsRefreshedPluginIndexPersistence,
  persistRefreshedPluginIndex,
  readDoctorConfigPreflightSnapshot,
  type DoctorConfigPreflightPluginSnapshotRead,
} from "./doctor-config-preflight-plugin-index.js";
import {
  completeStartupMigrationPreflight,
  noteStateMigrationResult,
} from "./doctor-config-preflight-startup.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { maybeRepairPluginOpenClawHostLinks } from "./doctor-plugin-host-links.js";
import {
  refuseStartupMigrationsForLiveGatewayOwner,
  throwStartupMigrationGuardRejected,
} from "./doctor-startup-migration-refusal.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import {
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
} from "./doctor/shared/automatic-startup-config-repair.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";

const loadStateDirMigrations = createLazyRuntimeModule(
  () => import("../infra/state-migrations.state-dir.js"),
);

const loadLegacyCronRepair = createLazyRuntimeModule(
  () => import("./doctor/cron/legacy-repair.js"),
);

const configLog = createSubsystemLogger("config");

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
    /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
    doctorOnlyStateMigrations?: boolean;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  const stateMigrationsRequested = options.migrateState !== false;
  const gatewayStartupCheckpointRequired = options.requireStartupMigrationCheckpoint === true;
  // Startup publishes one aggregate report; ordinary Doctor calls keep their per-stage output.
  const migrationLog = gatewayStartupCheckpointRequired ? { info() {}, warn() {} } : undefined;
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
  let startupMigrationEnv = process.env;
  let shouldRecordStateCheckpoint = false;
  let shouldRecordStartupCheckpoint = false;
  let shouldPersistRefreshedPluginIndex = false;
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
  const refreshMigrationCheckpoint = (
    checkpoint: NonNullable<typeof migrationCheckpoint>,
    snapshotRead: DoctorConfigPreflightPluginSnapshotRead,
  ) => {
    const { snapshot, pluginMigrationFingerprint } = snapshotRead;
    migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
      snapshot,
      baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
      pluginMigrationFingerprint,
    });
    shouldRecordStateCheckpoint =
      stateMigrationsRequested &&
      checkpoint.needsStateMigrationCheckpoint({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
      });
    shouldRecordStartupCheckpoint =
      gatewayStartupCheckpointRequired &&
      checkpoint.needsStartupMigrationCheckpoint({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
      });
    shouldPersistRefreshedPluginIndex = needsRefreshedPluginIndexPersistence(snapshotRead);
  };
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
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
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
    noteStateMigrationResult({
      ...result,
      warnings: gatewayStartupCheckpointRequired ? [] : result.warnings,
    });
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
      // Later config reads can apply state selectors. Pin the accepted lease target for its lifetime.
      startupMigrationEnv = cloneEnvWithPlatformSemantics(process.env);
      refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
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
    const stateDirMigrations =
      stateMigrationsRequested &&
      (!migrationCheckpoint || shouldRecordStateCheckpoint) &&
      !skipPristineStartupStateMigrations
        ? await measurePreflightStep("state-migrations-import", loadStateDirMigrations)
        : undefined;
    if (stateDirMigrations && stateMigrationsAllowed) {
      const { autoMigrateLegacyStateDir } = stateDirMigrations;
      const stateDirResult = await measurePreflightStep("state-dir-migrations", () =>
        autoMigrateLegacyStateDir({ env: process.env, log: migrationLog }),
      );
      noteStartupStateMigrationResult(stateDirResult);
    }

    await migrateLegacyConfigIfNeeded();
    if (!configSnapshotRead || stateDirMigrations) {
      // Legacy state migration can move the persisted plugin index into the canonical state root.
      // Re-read before config-dependent migrations so their checkpoint names that final inventory.
      configSnapshotRead = await readConfigSnapshotForPreflight(!stateDirMigrations);
    }

    let snapshot = configSnapshotRead.snapshot;
    let activeConfigRepair: ReturnType<typeof planAutomaticConfigRepair> = null;
    if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
      // Migrate readable active bytes before rollback; otherwise one retired key can discard
      // newer valid settings that the canonical Doctor migration would preserve.
      activeConfigRepair =
        typeof snapshot.raw === "string" && parseConfigJson5(snapshot.raw).ok
          ? runWithPluginMetadataSnapshot(
              { config: snapshot.sourceConfig ?? snapshot.config ?? {} },
              () => planAutomaticConfigRepair(snapshot),
            )
          : null;
      let configRepaired = false;
      if (!activeConfigRepair && (await recoverConfigFromJsonRootSuffix(snapshot))) {
        note(
          "Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.",
          "Config",
        );
        configRepaired = true;
      } else if (
        !activeConfigRepair &&
        (await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" }))
      ) {
        note(
          "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
          "Config",
        );
        configRepaired = true;
      }
      if (configRepaired) {
        configSnapshotRead = await readConfigSnapshotForPreflight(false);
        snapshot = configSnapshotRead.snapshot;
      }
      if (
        !snapshot.valid &&
        typeof snapshot.raw === "string" &&
        !parseConfigJson5(snapshot.raw).ok
      ) {
        throw new Error(
          `Config at ${snapshot.path} is not parseable and cannot be repaired automatically. The file remains unchanged. Inspect the exact parse error with ${formatCliCommand("openclaw config validate")}, then hand-edit the file; or move it aside and run ${formatCliCommand("openclaw onboard")} to generate a fresh config.`,
        );
      }
    }
    const invalidConfigNote =
      options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
    if (
      invalidConfigNote &&
      snapshot.exists &&
      !snapshot.valid &&
      !activeConfigRepair &&
      snapshot.legacyIssues.length === 0
    ) {
      note(invalidConfigNote, "Config");
      noteIncludeConfinementWarning(snapshot);
    }

    const warnings = snapshot.warnings ?? [];
    if (warnings.length > 0) {
      // Non-interactive Gateway stdout is a log stream; preserve its structured logging contract.
      if (process.stdout.isTTY) {
        note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
      } else {
        logConfigWarningsOnce({ configPath: snapshot.path, warnings, logger: configLog });
      }
    }

    let baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    const automaticConfigRepair =
      activeConfigRepair ??
      (gatewayStartupCheckpointRequired &&
      !snapshot.valid &&
      !shouldSkipPluginValidationForDoctorConfigPreflight()
        ? runWithPluginMetadataSnapshot({ config: baseConfig }, () =>
            planAutomaticConfigRepair(snapshot),
          )
        : null);
    const stateMigrationInput = resolveStateMigrationConfigInput({ snapshot, baseConfig });
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
      stateDirMigrations !== undefined ||
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
    if (stateDirMigrations && stateMigrationsAllowed && freshConfigGuardAllowed) {
      if (options.doctorOnlyStateMigrations === true) {
        const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
          await import("../infra/state-migrations.exec-approvals.js");
        const stateDir = resolveStateDir(process.env);
        // Exec approvals are state-root policy. Repair them before config validity
        // decides which config-dependent migration graph is safe to run.
        noteStartupStateMigrationResult(
          await measurePreflightStep("exec-approvals-migration", () =>
            migrateLegacyExecApprovals({
              detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
              stateDir,
              env: process.env,
            }),
          ),
        );
      }
      if (gatewayStartupCheckpointRequired && (snapshot.valid || automaticConfigRepair)) {
        if (!startupMigrationLease) {
          throw new Error("Startup plugin host-link repair requires the startup migration lease.");
        }
        // Repair host links under the pinned lease before plugin migrations import packages.
        await measurePreflightStep("plugin-host-link-repair", () =>
          maybeRepairPluginOpenClawHostLinks({
            env: startupMigrationEnv,
            prompter: { shouldRepair: true },
          }),
        );
      }
      const { autoMigrateLegacyTaskStateSidecars } = stateDirMigrations;
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
          const { autoMigrateLegacyPluginDoctorState } =
            await import("../infra/state-migrations.plugin-doctor.js");
          noteStartupStateMigrationResult(
            await measurePreflightStep("plugin-doctor-migrations", () =>
              runWithPluginMetadataSnapshot({ config: pluginDoctorOnlyConfig }, () =>
                autoMigrateLegacyPluginDoctorState({
                  config: pluginDoctorOnlyConfig,
                  env: process.env,
                  log: migrationLog,
                  ...(options.doctorOnlyStateMigrations === true
                    ? { doctorOnlyStateMigrations: true }
                    : {}),
                }),
              ),
            ),
          );
        } else if (stateMigrationInput.cfg) {
          const { autoMigrateLegacyState } = await import("../infra/state-migrations.doctor.js");
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
                log: migrationLog,
                recoverCorruptTargetStore: options.recoverCorruptTargetStore,
                doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
                ...(gatewayStartupCheckpointRequired
                  ? { allowLegacyDeviceIdentityImport: true }
                  : {}),
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
            const { migrateLegacyConfigMachineState } =
              await import("../infra/state-migrations.config-machine-state.js");
            noteStartupStateMigrationResult(
              migrateLegacyConfigMachineState({ config: pluginDoctorConfig, env: process.env }),
            );
          }
          const { autoMigrateLegacyPluginDoctorState } =
            await import("../infra/state-migrations.plugin-doctor.js");
          noteStartupStateMigrationResult(
            await measurePreflightStep("plugin-doctor-migrations", () =>
              runWithPluginMetadataSnapshot({ config: pluginDoctorConfig }, () =>
                autoMigrateLegacyPluginDoctorState({
                  config: pluginDoctorConfig,
                  env: process.env,
                  log: migrationLog,
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
                log: migrationLog,
              }),
            ),
          );
        }
      } else {
        noteStartupStateMigrationResult(
          await measurePreflightStep("task-sidecar-migrations", () =>
            autoMigrateLegacyTaskStateSidecars({
              env: process.env,
              log: migrationLog,
            }),
          ),
        );
      }
    }
    if (
      stateDirMigrations &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      options.doctorOnlyStateMigrations === true &&
      !doctorMediaPersistenceAttempted
    ) {
      const { migrateLegacyMediaPersistence } =
        await import("../infra/state-migrations.media-persistence.js");
      noteStartupStateMigrationResult(
        await measurePreflightStep("media-persistence-migration", () =>
          migrateLegacyMediaPersistence({ env: process.env }),
        ),
      );
    }
    // State migrations must consume retired locators before the config write removes them.
    // Unsafe migration failures throw; advisory findings must not strand repairable config.
    if (automaticConfigRepair && stateMigrationsAllowed && freshConfigGuardAllowed) {
      if (gatewayStartupCheckpointRequired && !startupMigrationLease) {
        throw new Error("Automatic startup config repair requires the startup migration lease.");
      }
      // No snapshot argument: the guard re-reads the config from disk, so an external
      // edit made while state migrations ran refuses the stale planned write here.
      const configRepairAllowed =
        options.beforeStateMigrations === undefined ||
        (await measurePreflightStep("startup-config-repair-guard", () =>
          options.beforeStateMigrations?.(),
        ));
      if (!configRepairAllowed) {
        throwStartupMigrationGuardRejected();
      }
      startupMigrationLease?.heartbeat();
      await measurePreflightStep("automatic-config-repair", () =>
        runWithPluginMetadataSnapshot({ config: automaticConfigRepair.config }, () =>
          commitAutomaticConfigRepair(automaticConfigRepair, snapshot),
        ),
      );
      note(
        `Migrated legacy config keys${activeConfigRepair ? " in the active openclaw.json" : " at startup"}:\n${automaticConfigRepair.changes.map((entry) => `- ${entry}`).join("\n")}`,
        "Doctor changes",
      );
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      if (
        options.beforeStateMigrations &&
        !(await measurePreflightStep("repaired-config-guard", () =>
          options.beforeStateMigrations?.(snapshot),
        ))
      ) {
        throwStartupMigrationGuardRejected();
      }
      if (migrationCheckpoint) {
        refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
      }
    }
    if (
      migrationCheckpoint &&
      configSnapshotRead.pluginMetadataSnapshot &&
      configSnapshotRead.pluginMetadataSnapshot.policyHash !==
        resolveInstalledPluginIndexPolicyHash(baseConfig, startupMigrationEnv)
    ) {
      // State migration can invalidate an initially persisted inventory too.
      // Refresh before deciding whether the post-migration index needs persistence.
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
    }
    if (
      shouldPersistRefreshedPluginIndex &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
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
      // The durable reread supplies the accepted inventory. Replace both the
      // authoritative snapshot and its checkpoint identity at that boundary.
      configSnapshotRead = persistedSnapshotRead;
      migrationCheckpointIdentity = persistedIdentity;
    }
    configSnapshotRead = await completeStartupMigrationPreflight({
      freshConfigGuardAllowed,
      gatewayStartupCheckpointRequired,
      migrationCheckpoint,
      migrationCheckpointIdentity,
      measure: options.measure,
      readConfigSnapshotForPreflight,
      shouldRecordStartupCheckpoint,
      shouldRecordStateCheckpoint,
      snapshotRead: configSnapshotRead,
      startupMigrationEnv,
      startupMigrationHeartbeatError,
      startupMigrationLease,
      startupMigrationWarnings,
      stateMigrationsAllowed,
    });
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};

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
