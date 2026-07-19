/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { PluginPayloadSmokeFailure } from "../cli/update-cli/plugin-payload-validation.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import {
  parseConfigJson5,
  preserveConfigSnapshotAsClobbered,
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  formatPluginVerificationDiagnostic,
  setActiveDegradedPlugins,
  type DegradedPlugin,
} from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";
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

type StartupPluginVerificationDiagnostic = {
  kind: "plugin-verification";
  messages: string[];
};

type StartupPluginConvergenceResult = {
  blockingDiagnostic: StartupPluginVerificationDiagnostic | null;
  quarantinedPlugins: DegradedPlugin[];
};

async function planStartupPluginVerification(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const { planStartupPluginConvergence } = await measureStartupPreflightStep(
    "plugin-plan-import",
    () => import("./doctor/shared/startup-plugin-convergence-plan.js"),
  );
  return await measureStartupPreflightStep("plugin-plan", () =>
    planStartupPluginConvergence({
      config: params.cfg,
      env: params.env,
    }),
  );
}

function buildStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  failures: readonly PluginPayloadSmokeFailure[];
}): DegradedPlugin[] {
  return buildDegradedPluginsFromVerificationFailures(
    params.failures.filter(
      (failure) =>
        Boolean(failure.installPath) &&
        isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
    ),
  );
}

function isStartupPluginVerificationFailureActive(params: {
  cfg: OpenClawConfig;
  failure: PluginPayloadSmokeFailure;
}): boolean {
  return resolveEffectiveEnableState({
    id: params.failure.pluginId,
    origin: "global",
    config: normalizePluginsConfig(params.cfg.plugins),
    rootConfig: params.cfg,
  }).enabled;
}

function formatStartupPluginSmokeFailure(failure: PluginPayloadSmokeFailure): string {
  return `Plugin "${failure.pluginId}": ${formatPluginVerificationDiagnostic({
    kind: "plugin-verification",
    reason: failure.reason,
    detail: failure.detail,
    ...(failure.installPath ? { installPath: failure.installPath } : {}),
  })}. Run \`openclaw update repair\` to retry plugin repair.`;
}

async function runStartupUpgradeConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
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
  const quarantinedPlugins = buildStartupPluginQuarantine({
    cfg: params.cfg,
    failures: convergence.smokeFailures,
  });
  const nonBlockingWarningKeys = new Set(
    convergence.smokeFailures
      .filter(
        (failure) =>
          Boolean(failure.installPath) ||
          !isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
      )
      .map((failure) => JSON.stringify([failure.pluginId, `${failure.reason}: ${failure.detail}`])),
  );
  const blockingMessages = convergence.warnings
    .filter(
      (warning) =>
        !warning.pluginId ||
        !nonBlockingWarningKeys.has(JSON.stringify([warning.pluginId, warning.reason])),
    )
    .map((warning) => `${warning.message} ${warning.guidance.join(" ")}`.trim());
  return {
    blockingDiagnostic:
      blockingMessages.length > 0
        ? { kind: "plugin-verification", messages: blockingMessages }
        : null,
    quarantinedPlugins,
  };
}

async function refreshStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
  }
  const { runActivePluginPayloadSmokeCheck } = await measureStartupPreflightStep(
    "plugin-payload-verification-import",
    () => import("../cli/update-cli/active-plugin-payload-validation.js"),
  );
  const smoke = await measureStartupPreflightStep("plugin-payload-verification", () =>
    runActivePluginPayloadSmokeCheck({
      cfg: params.cfg,
      records: plan.installRecords,
      env: params.env,
    }),
  );
  const quarantinedPlugins = buildStartupPluginQuarantine({
    cfg: params.cfg,
    failures: smoke.failures,
  });
  const blockingFailures = smoke.failures.filter(
    (failure) =>
      !failure.installPath &&
      isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
  );
  if (quarantinedPlugins.length > 0) {
    note(
      quarantinedPlugins
        .map(
          (plugin) =>
            `- ${formatStartupPluginSmokeFailure({
              pluginId: plugin.pluginId,
              reason: plugin.diagnostic.reason,
              detail: plugin.diagnostic.detail,
              ...(plugin.diagnostic.installPath
                ? { installPath: plugin.diagnostic.installPath }
                : {}),
            })}`,
        )
        .join("\n"),
      "Doctor warnings",
    );
  }
  return {
    blockingDiagnostic:
      blockingFailures.length > 0
        ? {
            kind: "plugin-verification",
            messages: blockingFailures.map(formatStartupPluginSmokeFailure),
          }
        : null,
    quarantinedPlugins,
  };
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

function formatStartupPluginVerificationFailure(
  diagnostic: StartupPluginVerificationDiagnostic,
): string {
  return [
    "OpenClaw plugin verification failed; refusing to report the gateway ready.",
    ...diagnostic.messages.map((message) => `- ${message}`),
    "Resolve the plugin verification errors above, then restart the container.",
  ].join("\n");
}

function throwStartupMigrationRefusal(message: string): never {
  // ExitError bypasses entry.ts's generic failure formatter, so report the owned reason here.
  console.error(message);
  throw new ExitError(1, message);
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
    /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
    doctorOnlyStateMigrations?: boolean;
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
              doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
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
            }),
          );
        }
      } else {
        noteStartupStateMigrationResult(
          await autoMigrateLegacyTaskStateSidecars({
            env: process.env,
          }),
        );
      }
    }

    if (startupCheckpoint) {
      if (shouldRecordStartupCheckpoint) {
        if (startupMigrationHeartbeatError) {
          throw startupMigrationHeartbeatError instanceof Error
            ? startupMigrationHeartbeatError
            : new Error("OpenClaw startup migration lease heartbeat failed.");
        }
        if (startupMigrationWarnings.length > 0) {
          throwStartupMigrationRefusal(
            formatStartupMigrationFailure({
              warnings: startupMigrationWarnings,
              blockers: [],
            }),
          );
        }
        if (!snapshot.valid) {
          throwStartupMigrationRefusal(
            formatStartupMigrationFailure({
              warnings: [],
              blockers: ['OpenClaw config is invalid; run "openclaw doctor --fix" before startup.'],
            }),
          );
        }
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
            })
          : await refreshStartupPluginQuarantine({
              cfg: baseConfig,
              env: process.env,
            });
        setActiveDegradedPlugins(pluginConvergence.quarantinedPlugins);
        if (pluginConvergence.blockingDiagnostic) {
          throwStartupMigrationRefusal(
            formatStartupPluginVerificationFailure(pluginConvergence.blockingDiagnostic),
          );
        }
      }
      if (shouldRecordStartupCheckpoint) {
        startupCheckpoint.recordSuccessfulStartupMigrations({
          env: startupMigrationEnv,
          lease: startupMigrationLease,
        });
      }
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
