import type { ChildProcessWithoutNullStreams } from "node:child_process";

const OUTPUT_STREAM_TERMINATION_GRACE_MS = 5_000;
const forceKillTimers = new WeakMap<
  ChildProcessWithoutNullStreams,
  ReturnType<typeof setTimeout>
>();

/** Covers the spawn-to-response-reader handoff before an operation-specific handler is attached. */
export function ignoreChildOutputStreamErrors(child: ChildProcessWithoutNullStreams): void {
  const ignoreOutputStreamError = () => {};
  child.stdout.on("error", ignoreOutputStreamError);
  child.stderr.on("error", ignoreOutputStreamError);
}

export function onChildOutputStreamError(
  child: ChildProcessWithoutNullStreams,
  onError: (message: string) => void,
  operation = "sandbox http/request",
): void {
  const streamErrorToFail = (error: Error) => {
    onError(`${operation} output stream error: ${error.message}`);
  };
  child.stdout.on("error", streamErrorToFail);
  child.stderr.on("error", streamErrorToFail);
}

/** Requests graceful termination, then bounds the wait for the child close event. */
export function terminateChildWithEscalation(child: ChildProcessWithoutNullStreams): void {
  if (forceKillTimers.has(child)) {
    return;
  }
  const clearForceKill = () => {
    const timer = forceKillTimers.get(child);
    if (timer) {
      clearTimeout(timer);
    }
    forceKillTimers.delete(child);
  };
  child.once("close", clearForceKill);
  child.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    forceKillTimers.delete(child);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    // A wrapper can exit while descendants retain its inherited descriptors.
    // Closing the failed delivery streams bounds the wait for ChildProcess
    // `close`, which remains the sole backend-finalization owner.
    child.stdout.destroy();
    child.stderr.destroy();
  }, OUTPUT_STREAM_TERMINATION_GRACE_MS);
  forceKillTimers.set(child, forceKillTimer);
  forceKillTimer.unref?.();
}
