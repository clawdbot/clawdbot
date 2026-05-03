import { createSubsystemLogger } from "../../logging/subsystem.js";

export const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";

const DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS = 1000;

type QaParentWatchdogTimer =
  | number
  | {
      unref?: () => unknown;
    };

type QaParentWatchdogDeps = {
  clearInterval?: (timer: QaParentWatchdogTimer) => void;
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => never | void;
  intervalMs?: number;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  logger?: Pick<ReturnType<typeof createSubsystemLogger>, "warn">;
  ownPid?: number;
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
  const setIntervalFn =
    deps.setInterval ??
    ((callback: () => void, ms: number) => setInterval(callback, ms) as QaParentWatchdogTimer);
  let stopped = false;
  let timer: QaParentWatchdogTimer;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearIntervalFn(timer);
  };

  timer = setIntervalFn(() => {
    if (stopped) {
      return;
    }
    try {
      kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        logger.warn(`QA gateway parent pid ${parentPid} exited; shutting down orphaned QA gateway`);
        stop();
        exit(0);
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
