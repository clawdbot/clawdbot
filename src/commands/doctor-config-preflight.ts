/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import {
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import { findDoctorLegacyConfigIssues } from "./doctor/shared/legacy-config-issues.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";

const loadDoctorStateMigrations = createLazyRuntimeModule(
  () => import("./doctor-state-migrations.js"),
);

const loadLegacyCronRepair = createLazyRuntimeModule(
  () => import("./doctor/cron/legacy-repair.js"),
);
const startupPreflightTraceStartedAt = performance.now();

async function measureStartupPreflightStep<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  if (!isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE)) {
    return await run();
  }
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    const durationMs = performance.now() - startedAt;
    const totalMs = performance.now() - startupPreflightTraceStartedAt;
    process.stderr.write(
      `[gateway] startup trace: cli.bootstrap.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  }
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
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
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
  cronCodexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
};

function collectDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): LegacyConfigIssue[] {
  if (!snapshot.exists) {
    return [];
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const sourceRaw = snapshot.parsed ?? resolvedRaw;
  return findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
}

function addDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  const legacyIssues = collectDoctorLegacyIssues(snapshot);
  if (legacyIssues.length === 0) {
    return snapshot;
  }
  return { ...snapshot, legacyIssues };
}

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

async function runStartupUpgradeConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const { planStartupPluginConvergence } = await measureStartupPreflightStep(
    "plugin-plan-import",
    () => import("./doctor/shared/startup-plugin-convergence-plan.js"),
  );
  const plan = await measureStartupPreflightStep("plugin-plan", () =>
    planStartupPluginConvergence({
      config: params.cfg,
      env: params.env,
    }),
  );
  if (!plan.required) {
    return [];
  }
  const { runPostCorePluginConvergence } = await measureStartupPreflightStep(
    "plugin-convergence-import",
    () => import("../cli/update-cli/post-core-plugin-convergence.js"),
  );
  const convergence = await measureStartupPreflightStep("plugin-convergence", () =>
    runPostCorePluginConvergence({
      cfg: params.cfg,
      env: params.env,
      baselineInstallRecords: plan.installRecords,
    }),
  );
  if (convergence.changes.length > 0) {
    note(convergence.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = convergence.notices ?? [];
  if (notices.length > 0) {
    note(
      notices.map((notice) => `- ${notice.message} ${notice.guidance.join(" ")}`.trim()).join("\n"),
      "Doctor notices",
    );
  }
  const warnings = convergence.warnings.map((warning) =>
    `${warning.message} ${warning.guidance.join(" ")}`.trim(),
  );
  if (warnings.length > 0) {
    note(warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return warnings;
}

function formatStartupMigrationFailure(params: { warnings: string[]; blockers: string[] }): string {
  const details = [
    ...params.warnings.map((warning) => `- ${warning}`),
    ...params.blockers.map((blocker) => `- ${blocker}`),
  ];
  return [
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    ...details,
    'Run "openclaw doctor --fix" against the mounted state/config, then restart the container.',
  ].join("\n");
}

function throwStartupMigrationGuardRejected(): never {
  throw new Error(
    "OpenClaw startup migrations were skipped because the selected config changed during startup; refusing to report the gateway ready. Retry startup so the new config can be validated.",
  );
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
    /** Return false or reject on config drift; the preflight always unwinds owned resources. */
    beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
    requireStartupMigrationCheckpoint?: boolean;
    /** Core state was proven absent before Gateway selection could create runtime files. */
    skipPristineCoreStateMigrations?: boolean;
    /** Prepared before Gateway bootstrap can create files under an otherwise pristine state root. */
    skipPristineStartupStateMigrations?: boolean;
    /**
     * Allows legacy imports whose source lives in the DEFAULT home state dir
     * while OPENCLAW_STATE_DIR points elsewhere. Only explicit doctor repair
     * runs opt in; the implicit CLI/gateway preflight must never archive
     * files that belong to another install's state dir.
     */
    crossStateDirImports?: boolean;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  const stateMigrationsRequested = options.migrateState !== false;
  const startupCheckpoint =
    options.requireStartupMigrationCheckpoint === true
      ? await import("../infra/startup-migration-checkpoint.js")
      : undefined;
  let stateMigrations: Awaited<ReturnType<typeof loadDoctorStateMigrations>> | undefined;
  let startupMigrationEnv = process.env;
  let shouldRecordStartupCheckpoint = false;
  let skipPristineStartupStateMigrations = options.skipPristineStartupStateMigrations === true;
  let skipPristineCoreStateMigrations =
    skipPristineStartupStateMigrations || options.skipPristineCoreStateMigrations === true;
  let startupMigrationLease: StartupMigrationLease | undefined;
  let startupMigrationHeartbeat: ReturnType<typeof setInterval> | undefined;
  let startupMigrationHeartbeatError: unknown;
  const startupMigrationWarnings: string[] = [];
  const cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[] = [];
  const noteStartupStateMigrationResult = (result: {
    changes: string[];
    warnings: string[];
    notices?: string[];
  }) => {
    startupMigrationWarnings.push(...result.warnings);
    noteStateMigrationResult(result);
  };
  try {
    if (startupCheckpoint && !skipPristineStartupStateMigrations) {
      // Capture pristine state before the Gateway's fresh-config guard can prepare runtime state.
      const { planPristineStartupStateMigrations } = await measureStartupPreflightStep(
        "pristine-state-plan-import",
        () => import("./doctor/shared/pristine-startup-state.js"),
      );
      const pristineStatePlan = await measureStartupPreflightStep("pristine-state-plan", () =>
        planPristineStartupStateMigrations(process.env),
      );
      skipPristineStartupStateMigrations = pristineStatePlan.skipAllStateMigrations;
      skipPristineCoreStateMigrations ||= pristineStatePlan.skipCoreStateMigrations;
    }
    // The gateway uses this last-moment guard to ensure its prepared config did not change before
    // any automatic migration mutates state. A rejected guard skips every state migration stage.
    const stateMigrationsAllowed =
      !stateMigrationsRequested ||
      options.beforeStateMigrations === undefined ||
      (await options.beforeStateMigrations());
    if (startupCheckpoint && !stateMigrationsAllowed) {
      throwStartupMigrationGuardRejected();
    }
    if (startupCheckpoint) {
      // Later config reads can apply state selectors. Pin the accepted lease target for its lifetime.
      startupMigrationEnv = cloneEnvWithPlatformSemantics(process.env);
      shouldRecordStartupCheckpoint = startupCheckpoint.needsStartupMigrationCheckpoint({
        env: startupMigrationEnv,
      });
      startupMigrationLease = shouldRecordStartupCheckpoint
        ? startupCheckpoint.acquireStartupMigrationLease({ env: startupMigrationEnv })
        : undefined;
      if (startupMigrationLease) {
        startupMigrationHeartbeat = setInterval(() => {
          try {
            startupMigrationLease?.heartbeat();
          } catch (error) {
            startupMigrationHeartbeatError = error;
          }
        }, 60_000);
        startupMigrationHeartbeat.unref?.();
      }
    }
    // A current version checkpoint proves this state root already completed every automatic
    // migration. Keep repeated Gateway boots out of the legacy/plugin migration import graph.
    stateMigrations =
      stateMigrationsRequested &&
      (!startupCheckpoint || shouldRecordStartupCheckpoint) &&
      !skipPristineStartupStateMigrations
        ? await measureStartupPreflightStep("state-migrations-import", loadDoctorStateMigrations)
        : undefined;
    if (stateMigrations && stateMigrationsAllowed) {
      const { autoMigrateLegacyStateDir } = stateMigrations;
      const stateDirResult = await measureStartupPreflightStep("state-dir-migrations", () =>
        autoMigrateLegacyStateDir({ env: process.env }),
      );
      noteStartupStateMigrationResult(stateDirResult);
    }

    if (options.migrateLegacyConfig !== false) {
      const legacyConfigChanges = await maybeMigrateLegacyConfig();
      if (legacyConfigChanges.length > 0) {
        note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
      }
    }

    const readOptions = {
      ...(options.observe === false ? { observe: false } : {}),
      skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
    };
    let snapshot = addDoctorLegacyIssues(
      await measureStartupPreflightStep("config-snapshot", () =>
        readConfigFileSnapshot(readOptions),
      ),
    );
    if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
      if (await recoverConfigFromJsonRootSuffix(snapshot)) {
        note(
          "Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.",
          "Config",
        );
        snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
      } else if (
        await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" })
      ) {
        note(
          "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
          "Config",
        );
        snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
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
    const stateMigrationInput = resolveStateMigrationConfigInput({ snapshot, baseConfig });
    const freshConfigGuardRequired = stateMigrations !== undefined || shouldRecordStartupCheckpoint;
    const freshConfigGuardAllowed =
      !freshConfigGuardRequired ||
      !stateMigrationsAllowed ||
      options.beforeStateMigrations === undefined ||
      (await options.beforeStateMigrations(snapshot));
    if (startupCheckpoint && !freshConfigGuardAllowed) {
      throwStartupMigrationGuardRejected();
    }
    if (stateMigrations && stateMigrationsAllowed && freshConfigGuardAllowed) {
      const {
        autoMigrateLegacyState,
        autoMigrateLegacyPluginDoctorState,
        autoMigrateLegacyTaskStateSidecars,
      } = stateMigrations;
      if (stateMigrationInput) {
        const pluginDoctorOnlyConfig =
          stateMigrationInput.pluginDoctorConfig ?? stateMigrationInput.cfg;
        if (skipPristineCoreStateMigrations && pluginDoctorOnlyConfig) {
          // Core state is absent, but plugin paths may own external migration state.
          // Keep their doctor owner active without loading channel/session detectors.
          noteStartupStateMigrationResult(
            await autoMigrateLegacyPluginDoctorState({
              config: pluginDoctorOnlyConfig,
              env: process.env,
            }),
          );
        } else if (stateMigrationInput.cfg) {
          const {
            collectCronCodexRuntimePolicyTargetsReadOnly,
            repairLegacyCronStoreWithoutPrompt,
          } = await loadLegacyCronRepair();
          const cronResult = await repairLegacyCronStoreWithoutPrompt({
            cfg: stateMigrationInput.cfg,
            migrateCodexModelRefs: false,
          });
          noteStartupStateMigrationResult(cronResult);
          if (options.repairPrefixedConfig === true) {
            const cronCodexPlan = await collectCronCodexRuntimePolicyTargetsReadOnly({
              cfg: stateMigrationInput.cfg,
            });
            cronCodexRuntimePolicyTargets.push(...cronCodexPlan.targets);
            noteStartupStateMigrationResult({ changes: [], warnings: cronCodexPlan.warnings });
          }
          noteStartupStateMigrationResult(
            await autoMigrateLegacyState({
              cfg: stateMigrationInput.cfg,
              ...(stateMigrationInput.pluginDoctorConfig
                ? { pluginDoctorConfig: stateMigrationInput.pluginDoctorConfig }
                : {}),
              env: process.env,
              recoverCorruptTargetStore: options.recoverCorruptTargetStore,
              crossStateDirImports: options.crossStateDirImports,
            }),
          );
        } else if (stateMigrationInput.pluginDoctorConfig) {
          noteStartupStateMigrationResult(
            await autoMigrateLegacyPluginDoctorState({
              config: stateMigrationInput.pluginDoctorConfig,
              env: process.env,
            }),
          );
          noteStartupStateMigrationResult(
            await autoMigrateLegacyTaskStateSidecars({
              env: process.env,
              crossStateDirImports: options.crossStateDirImports,
            }),
          );
        }
      } else {
        noteStartupStateMigrationResult(
          await autoMigrateLegacyTaskStateSidecars({
            env: process.env,
            crossStateDirImports: options.crossStateDirImports,
          }),
        );
      }
    }

    if (shouldRecordStartupCheckpoint) {
      if (startupMigrationHeartbeatError) {
        throw startupMigrationHeartbeatError instanceof Error
          ? startupMigrationHeartbeatError
          : new Error("OpenClaw startup migration lease heartbeat failed.");
      }
      const blockers =
        startupMigrationWarnings.length > 0
          ? []
          : snapshot.valid
            ? await runStartupUpgradeConvergence({ cfg: baseConfig, env: process.env })
            : ['OpenClaw config is invalid; run "openclaw doctor --fix" before startup.'];
      if (startupMigrationWarnings.length > 0 || blockers.length > 0) {
        throw new Error(
          formatStartupMigrationFailure({
            warnings: startupMigrationWarnings,
            blockers,
          }),
        );
      }
      startupCheckpoint?.recordSuccessfulStartupMigrations({
        env: startupMigrationEnv,
        lease: startupMigrationLease,
      });
    }

    return {
      snapshot,
      baseConfig,
      ...(cronCodexRuntimePolicyTargets.length > 0 ? { cronCodexRuntimePolicyTargets } : {}),
    };
  } finally {
    if (startupMigrationHeartbeat) {
      clearInterval(startupMigrationHeartbeat);
    }
    startupMigrationLease?.release();
  }
}
