// Gateway startup-migration readiness refusals shared by doctor config preflight.
import { ExitError } from "../runtime.js";

export function formatStartupMigrationFailure(params: {
  warnings: string[];
  blockers: string[];
}): string {
  const details = [
    ...params.warnings.map((warning) => `- ${warning}`),
    ...params.blockers.map((blocker) => `- ${blocker}`),
  ];
  return [
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    ...details,
    'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
  ].join("\n");
}

export function throwStartupMigrationRefusal(message: string): never {
  // ExitError bypasses entry.ts's generic failure formatter, so report the owned reason here.
  console.error(message);
  throw new ExitError(1, message);
}

export function throwStartupMigrationGuardRejected(): never {
  throw new Error(
    "OpenClaw startup migrations were skipped because the selected config changed during startup; refusing to report the gateway ready. Retry startup so the new config can be validated.",
  );
}

export function throwStartupMigrationIdentityChanged(): never {
  throwStartupMigrationRefusal(
    "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.",
  );
}

/**
 * A gateway startup that will refuse readiness must stay side-effect-free: when a live
 * gateway owns this state directory, the pending automatic migrations behind the startup
 * lease would relocate its files before the runtime lock acquisition refuses. Refuse first.
 * Probe-only: the runtime lock stays owned by the gateway run loop's restart lifecycle.
 * Test runs skip the probe like acquireGatewayLock does (locks are disabled under Vitest).
 */
export async function refuseStartupMigrationsForLiveGatewayOwner(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.VITEST || env.NODE_ENV === "test") {
    return;
  }
  const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
  const activeGateway = await readActiveGatewayLockIdentity({ env });
  if (activeGateway) {
    throwStartupMigrationRefusal(
      `Another gateway (pid ${activeGateway.pid}) already owns this state directory; refusing to run automatic startup migrations or report the gateway ready. Stop it with "openclaw gateway stop" (or select a different OPENCLAW_STATE_DIR), then retry startup.`,
    );
  }
}
