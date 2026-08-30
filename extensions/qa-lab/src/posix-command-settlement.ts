import type { ChildProcess } from "node:child_process";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";

type QaPosixCommandPrimary =
  | { type: "exit"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: "manual" | "timeout" }
  | { type: "parent-signal"; signal: "SIGINT" | "SIGTERM" }
  | { type: "spawn-error"; error: Error }
  | { type: "stream-error"; error: Error; stream: "stderr" | "stdout" };

type QaPosixCommandSettlementParams = {
  child: ChildProcess;
  settlementFailureMessage: string;
  executionTimeoutMs?: number;
  forceKillAfterMs: number;
  forwardParentSignals?: boolean;
  initialSignal: NodeJS.Signals;
  onStderrData?: (chunk: Buffer) => void;
  onSettled: (outcome: { primary: QaPosixCommandPrimary; settlementFailure?: Error }) => void;
  onStdoutData?: (chunk: Buffer) => void;
  processGroupId: number | undefined;
  verifyAfterMs: number;
  windowsCleanup?: {
    alive?: () => boolean;
    closeCompletesCleanup?: boolean;
    signal: (signal: NodeJS.Signals) => Error | undefined;
  };
};

export function createQaPosixCommandSettlement(params: QaPosixCommandSettlementParams) {
  const timers: NodeJS.Timeout[] = [];
  const errors: Error[] = [];
  let cleanupDone = false;
  let cleanupStarted = false;
  let disposed = false;
  let drainDeadline: NodeJS.Timeout | undefined;
  let drainIdle: NodeJS.Timeout | undefined;
  let drainTimedOut = false;
  let executionTimer: NodeJS.Timeout | undefined;
  let parentSignal: "SIGINT" | "SIGTERM" | undefined;
  let primary: QaPosixCommandPrimary | undefined;
  let stdioDrained = false;
  const windows = params.windowsCleanup;

  const schedule = (fn: () => void, delay: number) => {
    const timer = setTimeout(() => {
      fn();
    }, delay);
    timers.push(timer);
    return timer;
  };
  const cancel = (timer: NodeJS.Timeout | undefined) => {
    if (timer) {
      clearTimeout(timer);
    }
  };
  // Cleanup owns only the original PGID; a descendant that calls setsid can escape it.
  const alive = () =>
    windows?.alive?.() ??
    (windows
      ? true
      : params.processGroupId !== undefined && isQaPosixProcessGroupAlive(params.processGroupId));
  const signal = (nextSignal: NodeJS.Signals) => {
    const error = windows
      ? windows.signal(nextSignal)
      : params.processGroupId === undefined
        ? undefined
        : signalQaPosixProcessGroup(params.processGroupId, nextSignal);
    if (error) {
      errors.push(error);
    }
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    params.child.stdout?.removeListener("data", onStdoutData);
    params.child.stdout?.removeListener("error", onStdoutError);
    params.child.stderr?.removeListener("data", onStderrData);
    params.child.stderr?.removeListener("error", onStderrError);
    params.child.removeListener("error", onChildError);
    params.child.removeListener("exit", onExit);
    params.child.removeListener("close", onClose);
    process.removeListener("exit", onParentExit);
    process.removeListener("SIGINT", onParentSigint);
    process.removeListener("SIGTERM", onParentSigterm);
  };
  const settle = () => {
    if (disposed || !primary || !cleanupDone || !stdioDrained) {
      return;
    }
    const settlementFailure =
      errors.length > 1 ? new AggregateError(errors, params.settlementFailureMessage) : errors[0];
    dispose();
    params.onSettled({ primary, ...(settlementFailure ? { settlementFailure } : {}) });
    if (parentSignal) {
      process.kill(process.pid, parentSignal);
    }
  };
  const finishCleanup = () => {
    cleanupDone = true;
    if (drainTimedOut && !stdioDrained) {
      params.child.stdout?.destroy();
      params.child.stderr?.destroy();
      stdioDrained = true;
    }
    settle();
  };
  const verify = () => {
    if (alive() && !windows) {
      errors.push(
        new Error(`${params.settlementFailureMessage}: pgid=${params.processGroupId} alive`),
      );
    }
    if (!stdioDrained) {
      drainTimedOut = true;
      if (!windows && !errors.some((error) => error.message === "stdio-drain-timeout")) {
        errors.push(new Error("stdio-drain-timeout"));
      }
    }
    finishCleanup();
  };
  const forceKill = () => {
    if (!alive()) {
      finishCleanup();
      return;
    }
    signal("SIGKILL");
    schedule(verify, params.verifyAfterMs);
  };
  const startCleanup = (initialSignal = params.initialSignal) => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    if (!alive()) {
      finishCleanup();
      return;
    }
    signal(initialSignal);
    schedule(
      initialSignal === "SIGKILL" ? verify : forceKill,
      initialSignal === "SIGKILL" ? params.verifyAfterMs : params.forceKillAfterMs,
    );
  };
  const onDrainDeadline = () => {
    drainTimedOut = true;
    errors.push(new Error("stdio-drain-timeout"));
    startCleanup();
    if (cleanupDone) {
      finishCleanup();
    }
  };
  const armDrainDeadline = () => {
    if (!drainDeadline && !stdioDrained) {
      drainDeadline = schedule(onDrainDeadline, 1_000);
    }
  };
  const freeze = (nextPrimary: QaPosixCommandPrimary, initialSignal = params.initialSignal) => {
    primary ??= nextPrimary;
    cancel(executionTimer);
    // Every terminal path needs a drain bound: an escaped descendant can retain
    // inherited stdio even after the original process group is gone.
    armDrainDeadline();
    startCleanup(initialSignal);
    settle();
  };
  const armIdle = () => {
    cancel(drainIdle);
    drainIdle = schedule(startCleanup, 100);
  };
  const onOutput = () => {
    if (primary?.type === "exit" && !drainTimedOut && !stdioDrained) {
      armIdle();
    }
  };
  function onStdoutData(chunk: Buffer) {
    params.onStdoutData?.(chunk);
    onOutput();
  }
  function onStderrData(chunk: Buffer) {
    params.onStderrData?.(chunk);
    onOutput();
  }
  const freezeStreamError = (stream: "stderr" | "stdout", error: Error) => {
    if (primary) {
      errors.push(new Error(`${stream} stream error: ${error.message}`, { cause: error }));
    }
    freeze({ type: "stream-error", stream, error });
  };
  function onStdoutError(error: Error) {
    freezeStreamError("stdout", error);
  }
  function onStderrError(error: Error) {
    freezeStreamError("stderr", error);
  }
  function onChildError(error: Error) {
    freeze({ type: "spawn-error", error });
  }
  // `exit` freezes the leader tuple; only `close` can prove stdio drained.
  function onExit(exitCode: number | null, nextSignal: NodeJS.Signals | null) {
    primary ??= { type: "exit", exitCode, signal: nextSignal };
    cancel(executionTimer);
    armDrainDeadline();
    armIdle();
    if (cleanupStarted && !cleanupDone && !alive()) {
      finishCleanup();
    }
  }
  function onClose() {
    stdioDrained = true;
    cancel(drainIdle);
    cancel(drainDeadline);
    if (!cleanupStarted && windows) {
      cleanupDone = true;
    } else if (cleanupStarted && windows?.closeCompletesCleanup) {
      finishCleanup();
    } else {
      startCleanup();
      if (!cleanupDone && !alive()) {
        finishCleanup();
      }
    }
    settle();
  }
  function onParentExit() {
    signal("SIGKILL");
  }
  const onParentSignal = (nextSignal: "SIGINT" | "SIGTERM") => {
    if (windows) {
      primary ??= { type: "parent-signal", signal: nextSignal };
      signal(nextSignal);
      dispose();
      process.kill(process.pid, nextSignal);
      return;
    }
    // The command outcome may already be frozen while descendants drain.
    // Parent cancellation still has to be re-raised after cleanup.
    parentSignal ??= nextSignal;
    freeze({ type: "parent-signal", signal: nextSignal }, nextSignal);
  };
  function onParentSigint() {
    onParentSignal("SIGINT");
  }
  function onParentSigterm() {
    onParentSignal("SIGTERM");
  }

  params.child.stdout?.on("data", onStdoutData);
  params.child.stdout?.on("error", onStdoutError);
  params.child.stderr?.on("data", onStderrData);
  params.child.stderr?.on("error", onStderrError);
  params.child.on("error", onChildError);
  params.child.on("exit", onExit);
  params.child.on("close", onClose);
  if (params.forwardParentSignals) {
    process.on("exit", onParentExit);
    process.on("SIGINT", onParentSigint);
    process.on("SIGTERM", onParentSigterm);
  }
  if (params.executionTimeoutMs !== undefined) {
    executionTimer = schedule(() => freeze({ type: "timeout" }), params.executionTimeoutMs);
  }

  return { requestCleanup: () => freeze({ type: "manual" }) };
}
