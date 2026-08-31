import { spawn } from "node:child_process";
import { parseNodeWorkerDesktopLaunchInput } from "../worker/node-desktop-protocol.js";

const DESKTOP_LAUNCH_TIMEOUT_MS = 30_000;

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("node worker desktop launch aborted");
}

/** Directly runs one provider-attested zero-argument launcher without replay. */
export async function invokeNodeWorkerDesktopLaunch(params: {
  paramsJSON?: string | null;
  signal?: AbortSignal;
}): Promise<{ status: "ready" }> {
  const app = parseNodeWorkerDesktopLaunchInput(params.paramsJSON);
  const signal = params.signal;
  signal?.throwIfAborted();
  const child = spawn(app.executablePath, [], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const stop = (error: Error) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The terminal error still owns this one-shot launch result.
      }
      finish(error);
    };
    const onAbort = () => signal && stop(signalError(signal));
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, terminationSignal: NodeJS.Signals | null) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          terminationSignal
            ? `node worker desktop launcher terminated by ${terminationSignal}`
            : `node worker desktop launcher exited with code ${code ?? "unknown"}`,
        ),
      );
    };
    const timer = setTimeout(
      () => stop(new Error("node worker desktop launcher timed out")),
      DESKTOP_LAUNCH_TIMEOUT_MS,
    );
    timer.unref?.();
    child.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
  return { status: "ready" };
}
