// Gateway Bench Child script supports OpenClaw repository automation.
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sleep as delay } from "./sleep.mjs";
import { resolveWindowsTaskkillPath } from "./windows-taskkill.mjs";

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
  platform?: NodeJS.Platform;
  runTaskkill?: typeof spawnSync;
  teardownGraceMs?: number;
};

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: StopChildOptions = {},
): Promise<StopChildResult> {
  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? TEARDOWN_KILL_GRACE_MS;
  const processTreeOptions = {
    platform: options.platform ?? process.platform,
    runTaskkill: options.runTaskkill ?? spawnSync,
  };
  let observedExit: ChildExit | null = null;
  const directExit = (): ChildExit | null =>
    observedExit ??
    (child.exitCode != null || child.signalCode != null
      ? { exitCode: child.exitCode, signal: child.signalCode }
      : null);
  const currentExit = (): ChildExit | null => {
    const exit = directExit();
    if (exit == null || isProcessTreeAlive(child, processTreeOptions)) {
      return null;
    }
    return exit;
  };
  const waitForProcessTreeExit = async (ms: number): Promise<boolean> => {
    const deadlineAt = Date.now() + ms;
    while (Date.now() < deadlineAt) {
      if (!isProcessTreeAlive(child, processTreeOptions)) {
        return true;
      }
      await delay(Math.min(EXIT_POLL_MS, deadlineAt - Date.now()));
    }
    return !isProcessTreeAlive(child, processTreeOptions);
  };
  const cleanupExitedProcessTree = async (
    exit: ChildExit,
    exitedBeforeTeardown: boolean,
  ): Promise<StopChildResult> => {
    if (!isProcessTreeAlive(child, processTreeOptions)) {
      return { ...exit, exitedBeforeTeardown };
    }
    const sentTeardownSignal = killProcessTree(child, "SIGTERM", processTreeOptions);
    if (sentTeardownSignal) {
      await waitForProcessTreeExit(teardownGraceMs);
    }
    if (sentTeardownSignal && isProcessTreeAlive(child, processTreeOptions)) {
      killProcessTree(child, "SIGKILL", processTreeOptions);
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

  const sentTeardownSignal = killProcessTree(child, "SIGTERM", processTreeOptions);
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

  killProcessTree(child, "SIGKILL", processTreeOptions);
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

function isProcessTreeAlive(
  child: ChildProcessWithoutNullStreams,
  { platform = process.platform }: Pick<StopChildOptions, "platform"> = {},
): boolean {
  if (platform === "win32" || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return isProcessStillExistsError(error);
  }
}

function isProcessStillExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "EPERM";
}

function killProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  { platform = process.platform, runTaskkill = spawnSync }: StopChildOptions = {},
): boolean {
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child below.
    }
  }
  if (platform === "win32" && child.pid !== undefined) {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkillPath = resolveWindowsTaskkillPath();
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return true;
    }
    if (signal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return true;
      }
    }
  }
  return child.kill(signal);
}
