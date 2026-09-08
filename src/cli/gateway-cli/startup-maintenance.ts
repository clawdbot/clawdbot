import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isSqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { findOpenClawAgentDatabaseMediaMigrationRequiredError } from "../../state/openclaw-agent-db-migration-required.js";
import { findOpenClawStateDatabaseSchemaMigrationRequiredError } from "../../state/openclaw-state-db-schema-migration-required.js";
import { formatCliCommand } from "../command-format.js";

const gatewayLog = createSubsystemLogger("gateway");

export function resolveGatewayStartupMaintenanceReason(error: unknown) {
  if (collectNestedErrorCandidates(error).some(isSqliteSchemaVersionError)) {
    return "a newer OpenClaw build";
  }
  if (findOpenClawAgentDatabaseMediaMigrationRequiredError(error)) {
    return "offline media migration";
  }
  if (findOpenClawStateDatabaseSchemaMigrationRequiredError(error)) {
    return "state database schema migration";
  }
  return undefined;
}

export async function handleGatewayStartupMaintenance(error: unknown): Promise<boolean> {
  const reason = resolveGatewayStartupMaintenanceReason(error);
  if (!reason) {
    return false;
  }
  const guidance =
    reason === "a newer OpenClaw build"
      ? "Start the Gateway with a build that supports these database schemas. This install cannot repair a newer database."
      : `Run ${formatCliCommand("openclaw doctor --fix")} to repair and restart it.`;
  let parked = false;
  try {
    // launchd ignores exit 78 under KeepAlive. Park without opening the database,
    // which may also be unavailable to the persisted crash-loop counter.
    const { parkCurrentLaunchAgentForMaintenance } = await import("../../daemon/launchd.js");
    parked = await parkCurrentLaunchAgentForMaintenance();
  } catch (parkError) {
    gatewayLog.error(`failed to park the managed LaunchAgent: ${formatErrorMessage(parkError)}`);
  }
  gatewayLog.error(
    `gateway requires ${reason}${parked ? "; parked the managed LaunchAgent" : ""}. ${guidance}`,
  );
  defaultRuntime.error(`Gateway failed to start: ${formatErrorMessage(error)}. ${guidance}`);
  // systemd's RestartPreventExitStatus already treats EX_CONFIG as terminal.
  defaultRuntime.exit(78);
  return true;
}
