import type { GatewayRespawnSupervisor as Supervisor } from "./supervisor-markers.js";

export async function parkManagedUpdateSuccessor(supervisor: Supervisor | null) {
  if (supervisor === "launchd") {
    if (
      !(await (await import("../daemon/launchd-stop.js")).parkCurrentLaunchAgentForMaintenance())
    ) {
      throw new Error("current LaunchAgent identity is unavailable");
    }
  } else if (supervisor === "systemd") {
    await (
      await import("../daemon/systemd-lifecycle.js")
    ).parkCurrentSystemdServiceForMaintenance();
  }
}
