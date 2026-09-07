// Windows Task Scheduler bridge: retain the Job Object owner until the Gateway exits.
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_FLAG,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE,
} from "../../daemon/windows-task-supervisor-contract.js";
import { getProcessSupervisor, type ManagedRun } from "../../process/supervisor/index.js";

function renderGatewayTaskCommand(): string {
  const childArgs = [...process.execArgv, ...process.argv.slice(1)].filter(
    (argument) =>
      argument !== WINDOWS_TASK_SUPERVISOR_FLAG && argument !== WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  );
  if (childArgs.length === 0) {
    throw new Error("Windows task supervisor could not resolve the Gateway command");
  }
  return [process.execPath, ...childArgs, WINDOWS_TASK_SUPERVISOR_CHILD_FLAG]
    .map((argument) => quoteCmdScriptArg(argument))
    .join(" ");
}

/**
 * Runs the real Gateway inside the Windows Job Object owned by ProcessSupervisor.
 * The Task Scheduler action waits on this process; parent loss closes the Job and
 * its entire child tree, so a detached launcher cannot leave a stale Gateway behind.
 */
export async function runWindowsGatewayTaskSupervisor(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("--task-supervisor is only available to the Windows Gateway service");
  }
  let managed: ManagedRun | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    managed?.cancel("signal");
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    while (true) {
      managed = await getProcessSupervisor().spawn({
        mode: "anchored-shell",
        command: renderGatewayTaskCommand(),
        scopeKey: `gateway-task-supervisor:${process.pid}`,
        captureOutput: false,
      });
      if (cancelled) {
        managed.cancel("signal");
      }
      const result = await managed.wait();
      await managed.waitForExtinction?.();
      managed = null;
      if (!cancelled && result.exitCode === WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE) {
        // The child has released its Gateway lock and extinguished descendants.
        // Only this private outcome permits replacement; stop and update handoffs exit 0.
        continue;
      }
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode ?? 1;
      }
      return;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
