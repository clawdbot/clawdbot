import process from "node:process";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommand } from "./exec-spawn.js";
import { killProcessTree as terminateProcessTree } from "./kill-tree.js";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

type TerminationChild = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export function createCommandTerminationController(params: {
  child: TerminationChild;
  cancelController: AbortController;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  processTree?: { mode: "graceful" } | { mode: "force" };
  killGraceMs: number;
  killSignal?: NodeJS.Signals | number;
  isChildExited: () => boolean;
  isCommandSettled: () => boolean;
}): {
  terminate: () => boolean;
  settle: () => Promise<"normal" | "cooperative" | "forced" | "uncertain">;
} {
  let processTreeSettlement: Promise<void> | undefined;
  let cleanup: "normal" | "cooperative" | "forced" | "uncertain" = "normal";
  const originalStart =
    params.processTree && params.child.pid && process.platform !== "win32"
      ? getFileLockProcessStartTime(params.child.pid)
      : null;
  let windowsTerminationPromise: Promise<void> | undefined;

  const isDirectChildAlive = () =>
    !params.isChildExited() && params.child.exitCode == null && params.child.signalCode == null;
  const spawnTaskkill = (args: string[]) => {
    try {
      return spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
        baseEnv: params.baseEnv,
        env: params.env,
        forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        reject: false,
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      }).catch(() => undefined);
    } catch {
      return undefined;
    }
  };
  const startWindowsTermination = (childPid: number, graceful: boolean): void => {
    const taskkills: Promise<unknown>[] = [];
    const startTaskkill = (args: string[]) => {
      const taskkill = spawnTaskkill(args);
      if (taskkill) {
        taskkills.push(taskkill);
      }
    };
    windowsTerminationPromise = (async () => {
      if (graceful) {
        startTaskkill(["/PID", String(childPid), "/T"]);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, params.killGraceMs);
          timer.unref();
        });
        if (isDirectChildAlive()) {
          startTaskkill(["/PID", String(childPid), "/T", "/F"]);
        }
      } else {
        startTaskkill(["/PID", String(childPid), "/T", "/F"]);
      }
      // Failed helpers still join here before root cancellation; a sibling taskkill
      // may still be enumerating descendants through that live PID.
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
    if (params.processTree && typeof childPid === "number") {
      const force = params.processTree.mode === "force";
      if (process.platform === "win32") {
        startWindowsTermination(childPid, !force);
        return true;
      }
      if (force) {
        cleanup = "forced";
        terminateProcessTree(childPid, { force: true, detached: true });
        return false;
      }
      if (processTreeSettlement) {
        return true;
      }
      cleanup = "cooperative";
      const groupAlive = () => {
        try {
          process.kill(-childPid, 0);
          return true;
        } catch (error) {
          // SAFETY: Node's kill error carries errno; only ESRCH certifies absence.
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      try {
        process.kill(-childPid, params.killSignal ?? "SIGTERM");
      } catch (error) {
        // SAFETY: Node's kill error carries errno; every non-ESRCH result stays uncertain.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          cleanup = "uncertain";
        }
      }
      processTreeSettlement = new Promise<void>((resolve) => {
        const deadline = Date.now() + params.killGraceMs;
        const check = () => {
          if (!groupAlive()) {
            resolve();
            return;
          }
          if (Date.now() < deadline) {
            setTimeout(check, Math.min(25, deadline - Date.now()));
            return;
          }
          // Never signal a recycled group leader. A forced fallback cannot certify
          // cleanup of independently detached descendants of this invocation.
          const start = getFileLockProcessStartTime(childPid);
          if (start !== null && start !== originalStart) {
            cleanup = "uncertain";
            if (isDirectChildAlive()) {
              params.cancelController.abort();
            }
            resolve();
            return;
          }
          cleanup = "forced";
          terminateProcessTree(childPid, { force: true, detached: true });
          resolve();
        };
        check();
      });
      return true;
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

  const settle = async (): Promise<"normal" | "cooperative" | "forced" | "uncertain"> => {
    if (windowsTerminationPromise) {
      await windowsTerminationPromise;
      return "forced";
    }
    await processTreeSettlement;
    return cleanup;
  };

  return { terminate, settle };
}
