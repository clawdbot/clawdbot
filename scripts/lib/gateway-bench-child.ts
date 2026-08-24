// Gateway Bench Child script supports OpenClaw repository automation.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./managed-child-process.mts";
import { sleep as delay } from "./sleep.mjs";

export { delay };

const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_KILL_GRACE_MS = 1_000;
const EXIT_POLL_MS = 10;

type ChildExit = {
  exitCode: number | null;
  signal: string | null;
};

export type StopChildResult = ChildExit & {
  exitedBeforeTeardown: boolean;
};

type StopChildOptions = {
  killGraceMs?: number;
  teardownGraceMs?: number;
};

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: StopChildOptions = {},
): Promise<StopChildResult> {
  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? TEARDOWN_KILL_GRACE_MS;
  const processTreeAlive = () =>
    inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm" }) === "live";
  const signalProcessTree = (signal: NodeJS.Signals): boolean => {
    let delivered = true;
    terminateManagedChild(
      {
        kill(childSignal) {
          delivered = child.kill(childSignal);
          return delivered;
        },
        pid: child.pid,
      },
      signal,
      {
        onChildSignalError(error) {
          throw error;
        },
        taskkillTimeoutMs: null,
      },
    );
    return delivered;
  };
  let observedExit: ChildExit | null = null;
  const directExit = (): ChildExit | null =>
    observedExit ??
    (child.exitCode != null || child.signalCode != null
      ? { exitCode: child.exitCode, signal: child.signalCode }
      : null);
  const currentExit = (): ChildExit | null => {
    const exit = directExit();
    if (exit == null || processTreeAlive()) {
      return null;
    }
    return exit;
  };
  const waitForProcessTreeExit = (ms: number): Promise<boolean> =>
    waitForManagedProcessGroupExit(child, ms, {
      clampPollToDeadline: true,
      errorPolicy: "alive-on-eperm",
      pollIntervalMs: EXIT_POLL_MS,
    });
  const cleanupExitedProcessTree = async (
    exit: ChildExit,
    exitedBeforeTeardown: boolean,
  ): Promise<StopChildResult> => {
    if (!processTreeAlive()) {
      return { ...exit, exitedBeforeTeardown };
    }
    const sentTeardownSignal = signalProcessTree("SIGTERM");
    if (sentTeardownSignal) {
      await waitForProcessTreeExit(teardownGraceMs);
    }
    if (sentTeardownSignal && processTreeAlive()) {
      signalProcessTree("SIGKILL");
      await waitForProcessTreeExit(killGraceMs);
    }
    if (!sentTeardownSignal) {
      releaseUnsettledChild(child);
    }
    return { ...exit, exitedBeforeTeardown };
  };

  const existingExit = directExit();
  if (existingExit != null) {
    return await cleanupExitedProcessTree(existingExit, true);
  }

  const exited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      observedExit = { exitCode, signal };
      resolve(observedExit);
    });
  });
  const waitForExit = async (ms: number): Promise<ChildExit | null> => {
    const deadlineAt = Date.now() + ms;
    while (Date.now() < deadlineAt) {
      const waitMs = Math.min(EXIT_POLL_MS, deadlineAt - Date.now());
      if (directExit() == null) {
        await Promise.race([exited, delay(waitMs)]);
      } else {
        await delay(waitMs);
      }
      const exit = currentExit();
      if (exit != null) {
        return exit;
      }
    }
    return currentExit();
  };

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const queuedExit = directExit();
  if (queuedExit != null) {
    return await cleanupExitedProcessTree(queuedExit, true);
  }

  const sentTeardownSignal = signalProcessTree("SIGTERM");
  const gracefulExit = await waitForExit(teardownGraceMs);
  if (gracefulExit != null) {
    return { ...gracefulExit, exitedBeforeTeardown: !sentTeardownSignal };
  }

  const postGraceExit = currentExit();
  if (postGraceExit != null) {
    return { ...postGraceExit, exitedBeforeTeardown: !sentTeardownSignal };
  }
  if (!sentTeardownSignal) {
    releaseUnsettledChild(child);
    return { exitCode: null, exitedBeforeTeardown: true, signal: null };
  }

  signalProcessTree("SIGKILL");
  const killedExit = await waitForExit(killGraceMs);
  const finalExit = killedExit ?? currentExit();
  if (finalExit != null) {
    return { ...finalExit, exitedBeforeTeardown: false };
  }

  releaseUnsettledChild(child);
  return { exitCode: null, exitedBeforeTeardown: false, signal: "SIGKILL" };
}

function releaseUnsettledChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}
