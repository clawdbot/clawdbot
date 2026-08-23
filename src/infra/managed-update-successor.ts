import type { detectGatewayRespawnSupervisor } from "./supervisor-markers.js";

export async function parkManagedUpdateSuccessor(
  supervisor: ReturnType<typeof detectGatewayRespawnSupervisor>,
): Promise<void> {
  if (supervisor === null || supervisor === "external") {
    const ownership = supervisor === null ? "an unmanaged" : "an externally supervised";
    throw new Error(`managed update cannot park ${ownership} gateway`);
  }
  if (supervisor === "schtasks") {
    return;
  }
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
