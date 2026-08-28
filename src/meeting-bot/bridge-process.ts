type MeetingBridgeProcess = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

type TerminateMeetingBridgeProcessOptions = {
  graceMs: number;
  forceKillWaitMs?: number;
  initialSignal?: NodeJS.Signals;
};

function hasExited(proc: MeetingBridgeProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: MeetingBridgeProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(hasExited(proc)), timeoutMs);
    timeout.unref?.();
    proc.once("exit", onExit);
    if (hasExited(proc)) {
      finish(true);
    }
  });
}

/** Settles after the bridge exits or the bounded force-kill sequence finishes. */
export async function terminateMeetingBridgeProcess(
  proc: MeetingBridgeProcess | undefined,
  options: TerminateMeetingBridgeProcessOptions,
): Promise<void> {
  if (!proc || hasExited(proc)) {
    return;
  }
  const initialSignal = options.initialSignal ?? "SIGTERM";
  try {
    if (!proc.kill(initialSignal)) {
      return;
    }
  } catch {
    return;
  }
  const forceKillWaitMs = options.forceKillWaitMs ?? 1_000;
  if (initialSignal === "SIGKILL") {
    await waitForExit(proc, forceKillWaitMs);
    return;
  }
  if (await waitForExit(proc, options.graceMs)) {
    return;
  }
  try {
    if (!proc.kill("SIGKILL")) {
      return;
    }
  } catch {
    return;
  }
  await waitForExit(proc, forceKillWaitMs);
}
