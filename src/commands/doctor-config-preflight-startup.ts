import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import {
  formatStartupMigrationFailure,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
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
  throwStartupMigrationGuardRejected,
  throwStartupMigrationIdentityChanged,
  throwStartupMigrationRefusal,
} from "./doctor-startup-migration-refusal.js";

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
  const snapshot = params.snapshotRead.snapshot;
  if (
    snapshot.path !== refreshed.snapshot.path ||
    !isDeepStrictEqual(
      snapshot.sourceConfig ?? snapshot.config,
      refreshed.snapshot.sourceConfig ?? refreshed.snapshot.config,
    )
  ) {
    throwStartupMigrationIdentityChanged();
  }
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
    if (params.shouldRecordStartupCheckpoint && !snapshot.valid) {
      throwStartupMigrationRefusal(
        formatStartupMigrationFailure([
          'OpenClaw config is invalid; run "openclaw doctor --fix" before startup.',
        ]),
      );
    }
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

export function noteStateMigrationResult(result: MigrationMessages): void {
  for (const key of ["changes", "notices", "warnings"] as const) {
    if (result[key]?.length) {
      note(result[key].map((entry) => `- ${entry}`).join("\n"), `Doctor ${key}`);
    }
  }
}
