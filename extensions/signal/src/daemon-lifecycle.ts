import { formatSignalDaemonExit, type SignalDaemonHandle } from "./daemon.js";

export function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonStopPromise: Promise<void> | undefined;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, daemonAbortController.signal])
    : daemonAbortController.signal;
  const stop = (): Promise<void> => {
    if (daemonStopPromise) {
      return daemonStopPromise;
    }
    daemonStopRequested = true;
    if (!daemonAbortController.signal.aborted) {
      daemonAbortController.abort(
        params.abortSignal?.reason ?? new Error("Signal monitor stopped"),
      );
    }
    daemonStopPromise = daemonHandle?.stop() ?? Promise.resolve();
    return daemonStopPromise;
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (daemonStopRequested || params.abortSignal?.aborted) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      if (!daemonAbortController.signal.aborted) {
        daemonAbortController.abort(daemonExitError);
      }
    });
  };
  return { attach, stop, getExitError: () => daemonExitError, abortSignal };
}
