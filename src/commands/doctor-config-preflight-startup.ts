import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import { readConfigFileSnapshot, type ConfigSnapshotReadMeasure } from "../config/io.js";
import type { PreparedConfigRecovery } from "../config/io.types.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import {
  DoctorStateMigrationRefusalError,
  recordStartupMigrationWarnings,
  throwIfDoctorStateMigrationRefused,
} from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "../infra/state-migrations.types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  migrationCheckpointIdentitiesMatch,
  resolveMigrationCheckpointIdentity,
} from "./doctor-config-preflight-checkpoint.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";
import {
  formatStartupPluginVerificationFailure,
  refreshStartupPluginQuarantine,
  runStartupUpgradeConvergence,
} from "./doctor-config-preflight-plugin-verification.js";
import {
  refuseStartupMigrationsForLiveGatewayOwner,
  throwStartupMigrationGuardRejected,
  throwStartupMigrationIdentityChanged,
  throwStartupMigrationRefusal,
} from "./doctor-startup-migration-refusal.js";
import {
  type planAutomaticConfigRepair,
  resolveStartupConfigSnapshot,
} from "./doctor/shared/automatic-startup-config-repair.js";

/** Admit the same config and state before the lease and again before migration writes. */
export async function readStartupMigrationSnapshot(params: {
  env: NodeJS.ProcessEnv;
  readSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  planRepair: (
    read: DoctorConfigPreflightPluginSnapshotRead,
  ) => ReturnType<typeof planAutomaticConfigRepair>;
  validateConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStateMigrations?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<DoctorConfigPreflightPluginSnapshotRead & { recovery?: PreparedConfigRecovery }> {
  return await withArtifactPreservingStateReads(async () => {
    await refuseStartupMigrationsForLiveGatewayOwner(params.env);
    try {
      const selected = await readConfigFileSnapshot({
        observe: false,
        isolateEnv: true,
        pluginValidation: "core-only",
      });
      const recoveryOptions = { configPath: selected.path, observe: false, env: params.env };
      const coreRecovery = await createConfigIO({
        ...recoveryOptions,
        pluginValidation: "core-only",
      }).prepareConfigRecovery(selected);
      const candidate = coreRecovery?.snapshot ?? selected;
      const startupConfig = resolveStartupConfigSnapshot(candidate);
      await assertStartupStateMigrationReady({
        cfg: startupConfig?.sourceConfig ?? candidate.sourceConfig ?? candidate.config,
        env: params.env,
      });
      // Core readiness must be decided before plugin metadata opens shared state.
      if (startupConfig) {
        await params.validateConfig?.(startupConfig);
      }
      let read: DoctorConfigPreflightPluginSnapshotRead = coreRecovery
        ? {
            ...(await createConfigIO({
              ...recoveryOptions,
              env: cloneEnvWithPlatformSemantics(params.env),
            }).readConfigFileSnapshotWithPluginMetadata({ allowCurrentPluginMetadata: false })),
            pluginMigrationFingerprint: null,
          }
        : await params.readSnapshot();
      assertStartupConfigUnchanged(selected, read.snapshot);
      const recovery = await createConfigIO(recoveryOptions).prepareConfigRecovery(read.snapshot);
      if (Boolean(coreRecovery) !== Boolean(recovery)) {
        throwStartupMigrationIdentityChanged();
      }
      if (recovery) {
        assertStartupConfigUnchanged(candidate, recovery.snapshot);
        read = {
          snapshot: recovery.snapshot,
          pluginMetadataSnapshot: recovery.pluginMetadataSnapshot,
          pluginMigrationFingerprint:
            recovery.pluginMetadataSnapshot?.configFingerprint?.trim() || null,
        };
      }
      const repair = read.snapshot.valid ? null : params.planRepair(read);
      if (!read.snapshot.valid && !repair) {
        throw new Error('OpenClaw config is invalid; run "openclaw doctor --fix" before startup.');
      }
      await params.validateConfig?.(repair?.snapshot ?? read.snapshot);
      if (params.beforeStateMigrations && !(await params.beforeStateMigrations(read.snapshot))) {
        throwStartupMigrationGuardRejected();
      }
      return { ...read, ...(recovery ? { recovery } : {}) };
    } catch (error) {
      if (error instanceof ExitError) {
        throw error;
      }
      return throwStartupMigrationRefusal(formatErrorMessage(error), error);
    }
  });
}

function assertStartupConfigUnchanged(before: ConfigFileSnapshot, after: ConfigFileSnapshot): void {
  if (
    before.path !== after.path ||
    !isDeepStrictEqual(before.sourceConfig ?? before.config, after.sourceConfig ?? after.config)
  ) {
    throwStartupMigrationIdentityChanged();
  }
}

/** Admission runs before lease acquisition: even acquiring a lease commits SQLite writes. */
async function assertStartupStateMigrationReady(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { assertOpenClawDatabasesReady } = await import("../state/openclaw-database-preflight.js");
  await assertOpenClawDatabasesReady({
    env: params.env,
    config: params.cfg,
    operation: "gateway-startup",
  });
  const { assertSessionStoreMigrationComplete } =
    await import("../config/sessions/startup-migration.js");
  const { resolveAllAgentSessionStoreCandidateTargetsSync } =
    await import("../config/sessions/targets.js");
  const { inspectOpenClawRegisteredAgentDatabases } =
    await import("../state/openclaw-agent-db-registry.js");
  const targets = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
    env: params.env,
    registeredDatabases: inspectOpenClawRegisteredAgentDatabases({
      env: params.env,
      includeIncompatibleSchemaVersions: true,
    }),
  });
  assertSessionStoreMigrationComplete({ ...params, targets });
  const { assertConfiguredWorkspaceStateReady } = await import("../agents/workspace-state-dirs.js");
  assertConfiguredWorkspaceStateReady(params);
}

type MigrationCheckpoint = {
  recordSuccessfulStateMigrations: (params?: {
    env?: NodeJS.ProcessEnv;
    identity?: MigrationCheckpointIdentity | null;
    lease?: StartupMigrationLease;
  }) => void;
  recordSuccessfulStartupMigrations: (params?: {
    env?: NodeJS.ProcessEnv;
    identity?: MigrationCheckpointIdentity | null;
    lease?: StartupMigrationLease;
  }) => void;
};

/** Settle package repairs before state migrations select their plugin owners. */
export async function prepareStartupMigrationPlugins(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
  converge: boolean;
  lease: StartupMigrationLease | undefined;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  readRefreshedSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  beforeStateMigrations?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  if (params.converge) {
    if (!params.lease) {
      throw new Error("Startup plugin convergence requires the startup migration lease.");
    }
    params.lease.heartbeat();
  }
  setActiveDegradedPlugins([]);
  const convergence = await (
    params.converge ? runStartupUpgradeConvergence : refreshStartupPluginQuarantine
  )(params);
  setActiveDegradedPlugins(convergence.quarantinedPlugins);
  if (convergence.blockingDiagnostic) {
    throwStartupMigrationRefusal(
      formatStartupPluginVerificationFailure(convergence.blockingDiagnostic),
    );
  }
  if (!params.converge) {
    return params.snapshotRead;
  }
  const refreshed = await params.readRefreshedSnapshot();
  assertStartupConfigUnchanged(params.snapshotRead.snapshot, refreshed.snapshot);
  if (
    params.beforeStateMigrations &&
    !(await measureDoctorConfigPreflightStep(
      "converged-config-guard",
      () => params.beforeStateMigrations?.(refreshed.snapshot),
      params.measure,
    ))
  ) {
    throwStartupMigrationGuardRejected();
  }
  return refreshed;
}

/** Completes startup verification and returns the accepted config and metadata generation. */
export async function completeStartupMigrationPreflight(params: {
  freshConfigGuardAllowed: boolean | undefined;
  gatewayStartupCheckpointRequired: boolean;
  migrationCheckpoint: MigrationCheckpoint | undefined;
  migrationCheckpointIdentity: MigrationCheckpointIdentity | null;
  readConfigSnapshotForPreflight: (
    allowCurrentPluginMetadata?: boolean,
  ) => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  shouldRecordStartupCheckpoint: boolean;
  shouldRecordStateCheckpoint: boolean;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  startupMigrationEnv: NodeJS.ProcessEnv;
  startupMigrationHeartbeatError: unknown;
  startupMigrationLease: StartupMigrationLease | undefined;
  startupMigrationWarnings: readonly string[];
  stateMigrationsAllowed: boolean | undefined;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  let snapshotRead = params.snapshotRead;
  const snapshot = snapshotRead.snapshot;
  if (
    (params.shouldRecordStateCheckpoint || params.shouldRecordStartupCheckpoint) &&
    params.startupMigrationHeartbeatError
  ) {
    throw params.startupMigrationHeartbeatError instanceof Error
      ? params.startupMigrationHeartbeatError
      : new Error("OpenClaw startup migration lease heartbeat failed.");
  }
  if (
    params.shouldRecordStateCheckpoint &&
    params.stateMigrationsAllowed &&
    params.freshConfigGuardAllowed &&
    params.startupMigrationWarnings.length === 0 &&
    snapshot.valid
  ) {
    if (!params.migrationCheckpoint) {
      throw new Error("OpenClaw state migration checkpoint module was not loaded.");
    }
    params.migrationCheckpoint.recordSuccessfulStateMigrations({
      env: params.startupMigrationEnv,
      identity: params.migrationCheckpointIdentity,
      lease: params.startupMigrationLease,
    });
  }
  if (params.gatewayStartupCheckpointRequired) {
    if (snapshot.valid && params.shouldRecordStartupCheckpoint) {
      const convergedSnapshotRead = await params.readConfigSnapshotForPreflight(false);
      const convergedBaseConfig =
        convergedSnapshotRead.snapshot.sourceConfig ?? convergedSnapshotRead.snapshot.config ?? {};
      const convergedIdentity = resolveMigrationCheckpointIdentity({
        snapshot: convergedSnapshotRead.snapshot,
        baseConfig: convergedBaseConfig,
        pluginMigrationFingerprint: convergedSnapshotRead.pluginMigrationFingerprint,
      });
      if (
        !migrationCheckpointIdentitiesMatch(params.migrationCheckpointIdentity, convergedIdentity)
      ) {
        throwStartupMigrationIdentityChanged();
      }
      snapshotRead = convergedSnapshotRead;
    }
    recordStartupMigrationWarnings(params.startupMigrationWarnings);
  }
  // Advisory findings allow service, but must not certify unfinished migration work.
  if (params.shouldRecordStartupCheckpoint && params.startupMigrationWarnings.length === 0) {
    if (!params.migrationCheckpoint) {
      throw new Error("OpenClaw startup migration checkpoint module was not loaded.");
    }
    params.migrationCheckpoint.recordSuccessfulStartupMigrations({
      env: params.startupMigrationEnv,
      identity: params.migrationCheckpointIdentity,
      lease: params.startupMigrationLease,
    });
  }
  return snapshotRead;
}

export async function assertDoctorPreflightMigrationsComplete(params: {
  cfg: OpenClawConfig;
  stepReceipts: readonly LegacyStateMigrationStepReceipt[];
  report: (result: MigrationMessages) => void;
}): Promise<void> {
  try {
    throwIfDoctorStateMigrationRefused(params.stepReceipts);
  } catch (error) {
    if (error instanceof DoctorStateMigrationRefusalError) {
      // A refused owner stops all later repairs. Still diagnose canonical
      // workspace state read-only before final completion becomes unreachable.
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      try {
        assertConfiguredWorkspaceStateReady({ cfg: params.cfg, operation: "doctor" });
      } catch (workspaceError) {
        params.report({ changes: [], warnings: [String(workspaceError)] });
      }
    }
    throw error;
  }
}

export function noteStateMigrationResult(result: MigrationMessages): void {
  for (const key of ["changes", "notices", "warnings"] as const) {
    if (result[key]?.length) {
      note(result[key].map((entry) => `- ${entry}`).join("\n"), `Doctor ${key}`);
    }
  }
}
