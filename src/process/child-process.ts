/**
 * Child-process output cleanup for commands whose descendants inherit pipes.
 */
import type { ChildProcess } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;
const EXIT_STDIO_MAX_DRAIN_MS = 1_000;

/**
 * Execa waits for stdout/stderr after the direct child exits. Bound that wait
 * when detached descendants keep inherited pipes open, while still draining
 * short output tails. The returned cleanup must run after awaiting the child.
 */
export function releaseChildProcessOutputAfterExit(child: ChildProcess): () => void {
  let idleTimer: NodeJS.Timeout | undefined;
  let releaseImmediate: NodeJS.Immediate | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    clearTimeout(idleTimer);
    clearImmediate(releaseImmediate);
    clearTimeout(deadlineTimer);
    child.removeListener("exit", onExit);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  };
  const release = () => {
    cleanup();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const scheduleRelease = () => {
    // Either timer may run before already-buffered pipe data on a loaded loop.
    // Share one cancellable release after poll has had a turn to drain it.
    releaseImmediate ??= setImmediate(release);
    releaseImmediate.unref();
  };
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    clearImmediate(releaseImmediate);
    releaseImmediate = undefined;
    idleTimer = setTimeout(scheduleRelease, EXIT_STDIO_GRACE_MS);
    idleTimer.unref();
  };
  const onData = () => {
    if (deadlineTimer) {
      armIdleTimer();
    }
  };
  const onExit = () => {
    deadlineTimer = setTimeout(() => {
      // Post-deadline data must not cancel release and extend the hard bound.
      deadlineTimer = undefined;
      scheduleRelease();
    }, EXIT_STDIO_MAX_DRAIN_MS);
    deadlineTimer.unref();
    armIdleTimer();
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", onExit);
  return cleanup;
}
