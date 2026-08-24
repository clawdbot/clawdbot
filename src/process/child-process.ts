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
  let exited = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleReleaseImmediate: NodeJS.Immediate | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (idleReleaseImmediate) {
      clearImmediate(idleReleaseImmediate);
      idleReleaseImmediate = undefined;
    }
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  };
  const cleanup = () => {
    clearTimers();
    child.removeListener("exit", onExit);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  };
  const release = () => {
    cleanup();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (idleReleaseImmediate) {
      clearImmediate(idleReleaseImmediate);
      idleReleaseImmediate = undefined;
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      // A loaded event loop can observe the idle timer before already-buffered
      // pipe data. Give the poll phase one turn so that data can rearm the grace.
      idleReleaseImmediate = setImmediate(() => {
        idleReleaseImmediate = undefined;
        release();
      });
      idleReleaseImmediate.unref();
    }, EXIT_STDIO_GRACE_MS);
    idleTimer.unref();
  };
  const onData = () => {
    if (exited) {
      armIdleTimer();
    }
  };
  const onExit = () => {
    exited = true;
    armIdleTimer();
    deadlineTimer = setTimeout(release, EXIT_STDIO_MAX_DRAIN_MS);
    deadlineTimer.unref();
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", onExit);
  return cleanup;
}
