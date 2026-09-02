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
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";
import {
  formatStartupPluginVerificationFailure,
  refreshStartupPluginQuarantine,
  runStartupUpgradeConvergence,
} from "./doctor-config-preflight-plugin-verification.js";
import {
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

/** Completes startup checkpointing and plugin verification after state migration has run. */
export async function completeStartupMigrationPreflight(params: {
  baseConfig: OpenClawConfig;
  freshConfigGuardAllowed: boolean | undefined;
  gatewayStartupCheckpointRequired: boolean;
  migrationCheckpoint: MigrationCheckpoint | undefined;
  migrationCheckpointIdentity: MigrationCheckpointIdentity | null;
  measure?: ConfigSnapshotReadMeasure;
  readConfigSnapshotForPreflight: (
    allowCurrentPluginMetadata?: boolean,
  ) => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  shouldRecordStartupCheckpoint: boolean;
  shouldRecordStateCheckpoint: boolean;
  snapshot: ConfigFileSnapshot;
  startupMigrationEnv: NodeJS.ProcessEnv;
  startupMigrationHeartbeatError: unknown;
  startupMigrationLease: StartupMigrationLease | undefined;
  startupMigrationWarnings: readonly string[];
  stateMigrationsAllowed: boolean | undefined;
}): Promise<void> {
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
    params.snapshot.valid
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
    if (params.shouldRecordStartupCheckpoint && !params.snapshot.valid) {
      throwStartupMigrationRefusal(
        formatStartupMigrationFailure([
          'OpenClaw config is invalid; run "openclaw doctor --fix" before startup.',
        ]),
      );
    }
    setActiveDegradedPlugins([]);
    if (params.snapshot.valid) {
      const pluginConvergence = params.shouldRecordStartupCheckpoint
        ? await runStartupUpgradeConvergence({
            cfg: params.baseConfig,
            env: process.env,
            ...(params.measure ? { measure: params.measure } : {}),
          })
        : await refreshStartupPluginQuarantine({
            cfg: params.baseConfig,
            env: process.env,
            ...(params.measure ? { measure: params.measure } : {}),
          });
      setActiveDegradedPlugins(pluginConvergence.quarantinedPlugins);
      if (pluginConvergence.blockingDiagnostic) {
        throwStartupMigrationRefusal(
          formatStartupPluginVerificationFailure(pluginConvergence.blockingDiagnostic),
        );
      }
      if (params.shouldRecordStartupCheckpoint) {
        const convergedSnapshotRead = await params.readConfigSnapshotForPreflight(false);
        const convergedBaseConfig =
          convergedSnapshotRead.snapshot.sourceConfig ??
          convergedSnapshotRead.snapshot.config ??
          {};
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
      }
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
}

export function noteStateMigrationResult(result: MigrationMessages): void {
  for (const key of ["changes", "notices", "warnings"] as const) {
    if (result[key]?.length) {
      note(result[key].map((entry) => `- ${entry}`).join("\n"), `Doctor ${key}`);
    }
  }
}
