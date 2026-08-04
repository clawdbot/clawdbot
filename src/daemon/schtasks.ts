/** Windows Task Scheduler installer, startup fallback, and lifecycle controls. */
export {
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  startScheduledTask,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-control.js";
export {
  installScheduledTask,
  stageScheduledTask,
  uninstallScheduledTask,
} from "./schtasks-install.js";
export { readScheduledTaskCommand, resolveTaskScriptPath } from "./schtasks-layout.js";
export {
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
} from "./schtasks-runtime.js";
