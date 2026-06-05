// Doctor startup channel maintenance runs channel plugin startup repairs.
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Doctor wrapper for plugin startup maintenance repairs.
type DoctorStartupMaintenanceRuntime = {
  error: (message: string) => void;
  log: (message: string) => void;
};

type ChannelPluginStartupMaintenanceRunner = typeof runChannelPluginStartupMaintenance;

/** Runs channel plugin startup maintenance when doctor fix mode explicitly permits repairs. */
export async function maybeRunDoctorStartupChannelMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runChannelPluginStartupMaintenance?: ChannelPluginStartupMaintenanceRunner;
  runtime: DoctorStartupMaintenanceRuntime;
  shouldRepair: boolean;
}): Promise<void> {
  if (!params.shouldRepair) {
    return;
  }
  const runStartupMaintenance =
    params.runChannelPluginStartupMaintenance ?? runChannelPluginStartupMaintenance;
  await runStartupMaintenance({
    cfg: params.cfg,
    env: params.env ?? process.env,
    // Doctor maps startup warnings to terminal errors so repair output is visible.
    log: {
      info: (message) => params.runtime.log(message),
      warn: (message) => params.runtime.error(message),
    },
    trigger: "doctor-fix",
    logPrefix: "doctor",
  });
}
