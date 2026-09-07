import type { ChildProcess } from "node:child_process";

export type ReliabilityWorkerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export async function waitForReliabilityWorkerExit(
  child: ChildProcess,
  timeoutMessage: string,
): Promise<ReliabilityWorkerExit> {
  // A crash probe can reach this wait after exit was recorded; do not wait for a second event.
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<ReliabilityWorkerExit>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, 30_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

export function assertReliabilityForcedExit(
  exit: ReliabilityWorkerExit,
  workerLabel: string,
): void {
  if (exit.code === 0) {
    throw new Error(`${workerLabel} exited cleanly before forced termination.`);
  }
  // Windows can record a forced termination as an exit code instead of a POSIX signal.
  if (process.platform === "win32") {
    if (exit.code === null && exit.signal === null) {
      throw new Error(`${workerLabel} reported no forced Windows exit.`);
    }
    return;
  }
  if (exit.signal !== "SIGKILL") {
    throw new Error(
      `${workerLabel} exited without SIGKILL: code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
  }
}
