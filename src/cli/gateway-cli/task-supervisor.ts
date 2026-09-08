// Windows Task Scheduler bridge: retain the Job Object owner until the Gateway exits.
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import { WINDOWS_TASK_SUPERVISOR_FLAG } from "../../daemon/windows-task-supervisor-contract.js";
import { flushLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";

const log = createSubsystemLogger("gateway/task-supervisor");
const STDERR_TAIL_CHARS = 8192;

function renderGatewayTaskCommand(): string {
  const childArgs = [...process.execArgv, ...process.argv.slice(1)].filter(
    (argument) => argument !== WINDOWS_TASK_SUPERVISOR_FLAG,
  );
  if (childArgs.length === 0) {
    throw new Error("Windows task supervisor could not resolve the Gateway command");
  }
  return [process.execPath, ...childArgs].map((argument) => quoteCmdScriptArg(argument)).join(" ");
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
  let stderr = "";
  try {
    const managed = await getProcessSupervisor().spawn({
      mode: "anchored-shell",
      command: renderGatewayTaskCommand(),
      scopeKey: `gateway-task-supervisor:${process.pid}`,
      captureOutput: false,
      onStderr: (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      },
    });
    const cancel = () => managed.cancel("signal");
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await managed.wait();
      // Persist the child failure before joining cleanup, which can fail independently.
      const diagnostic = {
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        reason: result.reason,
        stderr,
      };
      if (result.exitCode === 0) {
        log.info("Gateway child exited", diagnostic);
      } else {
        process.exitCode = result.exitCode ?? 1;
        log.error("Gateway child failed", diagnostic);
      }
      await managed.waitForExtinction?.();
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch (error) {
    process.exitCode = 1;
    log.error(`Gateway task supervisor failed: ${String(error)}`, { stderr });
  } finally {
    await flushLogger();
  }
}
