/** Runs the Doctor-owned retired state-store migrations required by node-host startup. */
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "../infra/state-migrations.device-identity.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "../infra/state-migrations.exec-approvals.js";
import type { MigrationLogger, MigrationMessages } from "../infra/state-migrations.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

async function reportMigration(
  label: string,
  run: () => Promise<MigrationMessages | undefined>,
  log: MigrationLogger,
): Promise<void> {
  try {
    const result = await run();
    for (const change of result?.changes ?? []) {
      log.info(change);
    }
    for (const notice of result?.notices ?? []) {
      log.info(notice);
    }
    for (const warning of result?.warnings ?? []) {
      log.warn(warning);
    }
  } catch (error) {
    // Startup auto-migration is best-effort by operator decision. Existing store
    // gates remain the fail-closed authority when a Doctor-owned migrator throws.
    log.warn(`Failed running ${label} startup migration: ${formatErrorMessage(error)}`);
  }
}

/** Invoke the Doctor-owned state migrators authorized for node-host startup. */
export async function runStartupMigrations(params?: {
  env?: NodeJS.ProcessEnv;
  log?: MigrationLogger;
}): Promise<void> {
  const stateDir = resolveStateDir(params?.env);
  const env = { ...(params?.env ?? process.env), OPENCLAW_STATE_DIR: stateDir };
  const log = params?.log ?? createSubsystemLogger("node-host/startup-migrations");

  await reportMigration(
    "device auth",
    async () => {
      const detected = detectLegacyDeviceAuth({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      if (!detected.hasLegacy) {
        return undefined;
      }
      return await migrateLegacyDeviceAuth({ detected, env, stateDir });
    },
    log,
  );
  await reportMigration(
    "device identity",
    async () => {
      const detected = detectLegacyDeviceIdentity({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      });
      if (!detected.hasLegacy) {
        return undefined;
      }
      return await migrateLegacyDeviceIdentity({
        detected,
        env,
        stateDir,
        doctorOnlyStateMigrations: true,
      });
    },
    log,
  );
  await reportMigration(
    "exec approvals",
    async () => {
      const detected = detectLegacyExecApprovals({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      if (!detected.hasLegacy) {
        return undefined;
      }
      return await migrateLegacyExecApprovals({ detected, env, stateDir });
    },
    log,
  );
}
