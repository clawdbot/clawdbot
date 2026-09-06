import process from "node:process";

export type GatewayStartupSignalOwner = {
  signal: AbortSignal;
  /** Stop owning process signals once the Gateway run loop has installed its handlers. */
  release(): void;
  /** Remove listeners when startup exits before the run loop takes ownership. */
  dispose(): void;
};

/** Own SIGINT/SIGTERM across Gateway preflight and hand off to the run loop. */
export function installGatewayStartupSignalOwner(): GatewayStartupSignalOwner {
  const controller = new AbortController();
  let released = false;
  const onSignal = (signal: NodeJS.Signals, exitCode: number) => {
    if (controller.signal.aborted) {
      return;
    }
    process.exitCode = exitCode;
    controller.abort(new Error(`Gateway startup interrupted by ${signal}`));
  };
  const onSigterm = () => onSignal("SIGTERM", 143);
  const onSigint = () => onSignal("SIGINT", 130);
  const removeListeners = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return {
    signal: controller.signal,
    release() {
      if (released) {
        return;
      }
      released = true;
      removeListeners();
    },
    dispose() {
      if (released) {
        return;
      }
      released = true;
      removeListeners();
    },
  };
}
