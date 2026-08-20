import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type LegacyMigrationStateLockOptions = {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  releaseLabel: string;
  errorLabel?: string;
  retryGuidance?: string;
  formatAcquireError?: (error: unknown) => string;
  beforeRelease?: () => void | Promise<void>;
  run: (env: NodeJS.ProcessEnv) => Promise<MigrationMessages>;
};

/** Keep old Gateway writers excluded through migration, verification, and cleanup. */
export async function withLegacyMigrationStateLock(
  options: LegacyMigrationStateLockOptions,
): Promise<MigrationMessages> {
  const env = { ...(options.env ?? process.env), OPENCLAW_STATE_DIR: options.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 25,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : (options.formatAcquireError?.(error) ?? String(error));
    const guidance =
      options.retryGuidance ?? "Stop the Gateway and run `openclaw doctor --fix` again.";
    return {
      changes: [],
      warnings: [`Failed migrating ${options.label}: ${detail}. ${guidance}`],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: [`Failed migrating ${options.label}: exclusive state ownership unavailable.`],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      result = await options.run(env);
    } catch (error) {
      if (!options.errorLabel) {
        throw error;
      }
      result.warnings.push(`${options.errorLabel}: ${String(error)}`);
    }
  } finally {
    try {
      await options.beforeRelease?.();
    } catch (error) {
      releaseError = error;
    }
    try {
      await lock.release();
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError) {
    result.warnings.push(
      `${options.releaseLabel} migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}
