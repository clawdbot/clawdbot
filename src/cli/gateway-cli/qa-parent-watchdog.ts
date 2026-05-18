import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";
export const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
export const QA_STAGED_RUNTIME_ROOT_ENV = "OPENCLAW_QA_STAGED_RUNTIME_ROOT";

const DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS = 1000;
const QA_TEMP_ROOT_PREFIX = "openclaw-qa-suite-";

type QaParentWatchdogTimer =
  | number
  | {
      unref?: () => unknown;
    };

type QaParentWatchdogDeps = {
  chdir?: (directory: string) => void;
  clearInterval?: (timer: QaParentWatchdogTimer) => void;
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => never | void;
  intervalMs?: number;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  logger?: Pick<ReturnType<typeof createSubsystemLogger>, "warn">;
  ownPid?: number;
  rm?: (target: string) => Promise<void>;
  setInterval?: (callback: () => void, ms: number) => QaParentWatchdogTimer;
};

export type QaParentWatchdogHandle = {
  parentPid: number;
  stop: () => void;
};

function resolveQaParentPid(env: NodeJS.ProcessEnv, ownPid: number): number | null {
  const raw = env[QA_PARENT_PID_ENV]?.trim();
  if (!raw) {
    return null;
  }
  const parentPid = Number(raw);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === ownPid) {
    return null;
  }
  return parentPid;
}

function resolveQaCleanupRoot(rawValue: string | undefined): string | null {
  const raw = rawValue?.trim();
  if (!raw) {
    return null;
  }
  const cleanupRoot = path.resolve(raw);
  if (!path.basename(cleanupRoot).startsWith(QA_TEMP_ROOT_PREFIX)) {
    return null;
  }
  return cleanupRoot;
}

function resolveQaCleanupRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    resolveQaCleanupRoot(env[QA_TEMP_ROOT_ENV]),
    resolveQaCleanupRoot(env[QA_STAGED_RUNTIME_ROOT_ENV]),
  ].filter((target, index, array): target is string => {
    return target !== null && array.indexOf(target) === index;
  });
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function installQaParentWatchdog(
  deps: QaParentWatchdogDeps = {},
): QaParentWatchdogHandle | null {
  const env = deps.env ?? process.env;
  const ownPid = deps.ownPid ?? process.pid;
  const parentPid = resolveQaParentPid(env, ownPid);
  if (parentPid === null) {
    return null;
  }

  const clearIntervalFn =
    deps.clearInterval ??
    ((activeTimer: QaParentWatchdogTimer) => {
      clearInterval(activeTimer as ReturnType<typeof setInterval>);
    });
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  const kill =
    deps.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const logger = deps.logger ?? createSubsystemLogger("gateway");
  const qaCleanupRoots = resolveQaCleanupRoots(env);
  const chdir = deps.chdir ?? ((directory: string) => process.chdir(directory));
  const cwd = deps.cwd ?? (() => process.cwd());
  const rm =
    deps.rm ??
    (async (target: string) => {
      await fs.rm(target, { recursive: true, force: true });
    });
  const setIntervalFn =
    deps.setInterval ??
    ((callback: () => void, ms: number) => setInterval(callback, ms) as QaParentWatchdogTimer);
  let stopped = false;
  let exiting = false;
  let timer: QaParentWatchdogTimer;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearIntervalFn(timer);
  };

  timer = setIntervalFn(() => {
    if (stopped || exiting) {
      return;
    }
    try {
      kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        logger.warn(`QA gateway parent pid ${parentPid} exited; shutting down orphaned QA gateway`);
        exiting = true;
        stop();
        void (async () => {
          const currentCwd = path.resolve(cwd());
          const activeCwdRoot = qaCleanupRoots.find((cleanupRoot) =>
            pathContains(cleanupRoot, currentCwd),
          );
          if (activeCwdRoot) {
            const safeCwd = path.dirname(activeCwdRoot);
            try {
              chdir(safeCwd);
            } catch (chdirError) {
              logger.warn(
                `QA gateway parent pid ${parentPid} exited; failed to leave runtime root ${activeCwdRoot}: ${
                  chdirError instanceof Error ? chdirError.message : String(chdirError)
                }`,
              );
            }
          }
          for (const cleanupRoot of qaCleanupRoots) {
            await rm(cleanupRoot).catch((cleanupError) => {
              logger.warn(
                `QA gateway parent pid ${parentPid} exited; failed to clean runtime root ${cleanupRoot}: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            });
          }
          exit(0);
        })();
      }
    }
  }, deps.intervalMs ?? DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS);
  if (typeof timer === "object") {
    timer.unref?.();
  }

  return {
    parentPid,
    stop,
  };
}
