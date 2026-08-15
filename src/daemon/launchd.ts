/** macOS LaunchAgent installer, runtime inspection, and lifecycle controls. */
export { isLaunchctlNotLoaded } from "./launchd-exec.js";
export { installLaunchAgent, stageLaunchAgent, uninstallLaunchAgent } from "./launchd-install.js";
export {
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  startLaunchAgent,
} from "./launchd-lifecycle.js";
export { resolveLaunchAgentLabel } from "./launchd-label.js";
export {
  formatLaunchAgentGuiSessionError,
  isLaunchAgentEnabled,
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  parseLaunchAgentEnabled,
  parseLaunchctlPrint,
  readLaunchAgentRuntime,
} from "./launchd-runtime.js";
export {
  readLaunchAgentProgramArguments,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
export { parkCurrentLaunchAgentForMaintenance, stopLaunchAgent } from "./launchd-stop.js";
export {
  disableCurrentOpenClawUpdateLaunchdJob,
  disableOpenClawUpdateLaunchdJob,
  findStaleOpenClawUpdateLaunchdJobs,
  parseLaunchctlListOpenClawUpdateJobs,
  type StaleOpenClawUpdateLaunchdJob,
} from "./launchd-update-jobs.js";
