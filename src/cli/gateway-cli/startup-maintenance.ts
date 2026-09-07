import { formatErrorMessage } from "../../infra/errors.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

const gatewayLog = createSubsystemLogger("gateway");

export function resolveGatewayStartupMaintenanceReason(error: unknown) {
  return findStartupMaintenanceRequiredError(error)?.reason;
}

export async function handleGatewayStartupMaintenance(error: unknown): Promise<boolean> {
  const reason = resolveGatewayStartupMaintenanceReason(error);
  if (!reason) {
    return false;
  }
  const stop = `Stop the service with ${formatCliCommand("openclaw gateway stop")} (or its service owner), then`;
  const guidance =
    reason === "a newer OpenClaw build"
      ? `${stop} restore your pre-update backup created with ${formatCliCommand("openclaw backup")}, then start it again with ${formatCliCommand("openclaw gateway start")}. See https://docs.openclaw.ai/install/updating#rollback.`
      : `${stop} run ${formatCliCommand("openclaw doctor --fix")}, then start it again with ${formatCliCommand("openclaw gateway start")}.`;
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
