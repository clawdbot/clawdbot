// Windows Task Scheduler bridge: retain the Job Object owner until the Gateway exits.
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import {
  WINDOWS_TASK_LAUNCHER_ACTIVE,
  WINDOWS_TASK_LAUNCHER_ENV,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "../../daemon/windows-task-supervisor-contract.js";
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
 * The hidden task launcher owns an outer Job containing this supervisor. The
 * command anchor owns the inner Job used for cancellation and extinction joins.
 */
export async function runWindowsGatewayTaskSupervisor(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("--task-supervisor is only available to the Windows Gateway service");
  }
  let stderr = "";
  try {
    const launcher = process.env[WINDOWS_TASK_LAUNCHER_ENV];
    delete process.env[WINDOWS_TASK_LAUNCHER_ENV];
    if (launcher === WINDOWS_TASK_LAUNCHER_ACTIVE) {
      const [{ default: koffi }, { bindWindowsTaskLauncher }] = await Promise.all([
        import("koffi"),
        import("../../process/supervisor/service-child-windows-task-launcher.js"),
      ]);
      bindWindowsTaskLauncher(koffi);
    }
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
