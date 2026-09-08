import { constants as osConstants } from "node:os";
import process from "node:process";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
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
  const spawnTaskkill = async (args: string[]) => {
    try {
      await spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
        baseEnv: params.baseEnv,
        env: params.env,
        forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        reject: false,
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      });
    } catch {
      // Best-effort Windows cleanup still joins every attempted helper.
    }
  };
  const startWindowsTermination = (childPid: number, graceful: boolean): void => {
    const taskkills: Promise<unknown>[] = [];
    windowsTerminationPromise = (async () => {
      if (graceful) {
        taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T"]));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, params.killGraceMs);
          timer.unref();
        });
        if (isDirectChildAlive()) {
          taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T", "/F"]));
        }
      } else {
        taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T", "/F"]));
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
      if (process.platform === "win32") {
        startWindowsTermination(childPid, params.processTree.mode !== "force");
        return true;
      }
      const force =
        params.processTree.mode === "force" ||
        params.killSignal === "SIGKILL" ||
        params.killSignal === osConstants.signals.SIGKILL;
      if (processTreeSettlement) {
        return !force;
      }
      const groupAlive = () => isChildProcessTreeAlive({ pid: childPid });
      const forceAndObserve = async () => {
        const start = getFileLockProcessStartTime(childPid);
        if (start !== null && start !== originalStart) {
          cleanup = "uncertain";
          if (isDirectChildAlive()) {
            params.cancelController.abort();
          }
          return;
        }
        cleanup = "forced";
        terminateProcessTree(childPid, { force: true, detached: true });
        const deadline = Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
        // Signal delivery is not exit. Observe only this group; never re-signal a retired PID.
        while (groupAlive()) {
          const currentStart = getFileLockProcessStartTime(childPid);
          const remaining = deadline - Date.now();
          if ((currentStart !== null && currentStart !== originalStart) || remaining <= 0) {
            cleanup = "uncertain";
            return;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(25, remaining));
          });
        }
      };
      if (force) {
        processTreeSettlement = forceAndObserve();
        return false;
      }
      // Failed roots can finish without descendants. Record graceful cleanup only
      // when this invocation still owns a live or unproven tree to terminate.
      if (!directChildAlive && !groupAlive()) {
        return false;
      }
      cleanup = "cooperative";
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
          void forceAndObserve().then(resolve);
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
