// Gateway Bench Child script supports OpenClaw repository automation.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_KILL_GRACE_MS = 1_000;

export type ChildExit = {
  exitCode: number | null;
  signal: string | null;
};

export type StopChildResult = ChildExit & {
  exitedBeforeTeardown: boolean;
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: { killGraceMs?: number; teardownGraceMs?: number } = {},
): Promise<StopChildResult> {
  const currentExit = (): ChildExit | null =>
    child.exitCode != null || child.signalCode != null
      ? { exitCode: child.exitCode, signal: child.signalCode }
      : null;

  const existingExit = currentExit();
  if (existingExit != null) {
    return { ...existingExit, exitedBeforeTeardown: true };
  }

  let observedExit: ChildExit | null = null;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      observedExit = { exitCode, signal };
      resolve(observedExit);
    });
  });
  const waitForExit = async (ms: number): Promise<ChildExit | null> =>
    await Promise.race([exited, delay(ms).then(() => null)]);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const queuedExit = observedExit ?? currentExit();
  if (queuedExit != null) {
    return { ...queuedExit, exitedBeforeTeardown: true };
  }

  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? TEARDOWN_KILL_GRACE_MS;
  const sentTeardownSignal = killProcessTree(child, "SIGTERM");
  const gracefulExit = await waitForExit(teardownGraceMs);
  if (gracefulExit != null) {
    return { ...gracefulExit, exitedBeforeTeardown: !sentTeardownSignal };
  }

  const postGraceExit = currentExit() ?? observedExit;
  if (postGraceExit != null) {
    return { ...postGraceExit, exitedBeforeTeardown: !sentTeardownSignal };
  }
  if (!sentTeardownSignal) {
    releaseUnsettledChild(child);
    return { exitCode: null, exitedBeforeTeardown: true, signal: null };
  }

  killProcessTree(child, "SIGKILL");
  const killedExit = await waitForExit(killGraceMs);
  const finalExit = killedExit ?? currentExit() ?? observedExit;
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

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child below.
    }
  }
  return child.kill(signal);
}
