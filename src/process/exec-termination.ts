import process from "node:process";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
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
  isChildExited: () => boolean;
  isCommandSettled: () => boolean;
}): { terminate: () => boolean; settle: () => Promise<void> } {
  let processTreeSettleAt: number | undefined;
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
      if (!force) {
        processTreeSettleAt ??= Date.now() + params.killGraceMs;
      }
      if (process.platform === "win32") {
        startWindowsTermination(childPid, !force);
        return true;
      }
      terminateProcessTree(childPid, {
        ...(force ? { force: true } : { graceMs: params.killGraceMs }),
        detached: true,
      });
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
      params.processTree?.mode !== "graceful" ||
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
      terminateProcessTree(params.child.pid, { force: true, detached: true });
    }
  };

  return { terminate, settle };
}
