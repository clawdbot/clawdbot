import process from "node:process";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommand } from "./exec-spawn.js";
import { killProcessTree as terminateProcessTree } from "./kill-tree.js";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

type TerminationChild = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
};

export function createCommandTerminationController(params: {
  child: TerminationChild;
  cancelController: AbortController;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  killProcessTree?: boolean;
  isChildExited: () => boolean;
  isCommandSettled: () => boolean;
}): { terminate: () => boolean; settle: () => Promise<void> } {
  let processTreeSettleAt: number | undefined;
  let windowsTerminationPromise: Promise<void> | undefined;

  const isDirectChildAlive = () =>
    !params.isChildExited() && params.child.exitCode == null && params.child.signalCode == null;
  const killDirectChild = () => {
    if (isDirectChildAlive()) {
      params.child.kill("SIGKILL");
    }
  };
  const spawnTaskkillOrFallback = (args: string[], onSpawnError: () => void) => {
    try {
      const taskkillChild = spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
        baseEnv: params.baseEnv,
        env: params.env,
        forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        reject: false,
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      });
      return taskkillChild.then(
        (result) => {
          if (result.failed && result.exitCode === undefined) {
            onSpawnError();
          }
          return result;
        },
        () => {
          onSpawnError();
          return undefined;
        },
      );
    } catch {
      onSpawnError();
      return undefined;
    }
  };
  const startWindowsTermination = (childPid: number, graceful: boolean): void => {
    const taskkills: Promise<unknown>[] = [];
    const startTaskkill = (args: string[]) => {
      const taskkill = spawnTaskkillOrFallback(args, killDirectChild);
      if (taskkill) {
        taskkills.push(taskkill);
      }
    };
    windowsTerminationPromise = (async () => {
      if (graceful) {
        startTaskkill(["/PID", String(childPid), "/T"]);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          timer.unref();
        });
        if (isDirectChildAlive()) {
          startTaskkill(["/PID", String(childPid), "/T", "/F"]);
        }
      } else {
        startTaskkill(["/PID", String(childPid), "/T", "/F"]);
      }
      // taskkill owns the live PID while it enumerates descendants. Abort Execa
      // only after every started taskkill settles, avoiding a reused-PID race.
      await Promise.allSettled(taskkills);
      if (!params.isCommandSettled()) {
        params.cancelController.abort();
      }
    })();
  };

  const terminate = (): boolean => {
    const childPid = params.child.pid;
    const directChildAlive = isDirectChildAlive();
    if (process.platform === "win32" && !directChildAlive) {
      // taskkill /T requires a live root PID. Retrying a dead, reusable PID can
      // target an unrelated tree; stronger ownership requires a spawn-time Job Object.
      return false;
    }
    if (params.killProcessTree && typeof childPid === "number") {
      processTreeSettleAt ??= Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
      if (process.platform === "win32") {
        startWindowsTermination(childPid, true);
        return true;
      }
      terminateProcessTree(childPid, { graceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS });
      return false;
    }
    if (!directChildAlive) {
      return false;
    }
    if (process.platform === "win32" && typeof childPid === "number") {
      startWindowsTermination(childPid, false);
      return true;
    }
    return false;
  };

  const settle = async (): Promise<void> => {
    if (windowsTerminationPromise) {
      await windowsTerminationPromise;
    }
    if (
      !params.killProcessTree ||
      processTreeSettleAt === undefined ||
      typeof params.child.pid !== "number"
    ) {
      return;
    }
    // A direct child can exit before its descendants finish the graceful
    // signal. Keep the wrapper pending through that grace window, then ensure
    // the detached group cannot outlive the completed command result.
    const remainingMs = Math.max(0, processTreeSettleAt - Date.now());
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }
    if (process.platform !== "win32") {
      terminateProcessTree(params.child.pid, { force: true });
    }
  };

  return { terminate, settle };
}
