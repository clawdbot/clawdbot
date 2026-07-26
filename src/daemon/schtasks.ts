/** Public Windows Task Scheduler service adapter. */
export {
  isScheduledTaskInstalled,
  installScheduledTask,
  restartScheduledTask,
  stageScheduledTask,
  startScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks-install.js";
export {
  readScheduledTaskRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-runtime.js";
export { readScheduledTaskCommand, resolveTaskScriptPath } from "./schtasks-script.js";
