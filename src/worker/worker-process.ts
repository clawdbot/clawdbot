import { enableConsoleCapture, routeLogsToStderr } from "../logging/console.js";
import { signalProcessTree } from "../process/kill-tree.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  type NodeWorkerConnectionFailureMessage,
} from "./node-supervisor-protocol.js";
import { hasExactOwnKeys } from "./protocol-record.js";
import { runWorkerCommand, type WorkerCommandLifetime } from "./worker-command.runtime.js";

const WORKER_START_MESSAGE_TYPE = "openclaw-worker-start-v1";

function isWorkerStartMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    hasExactOwnKeys(value as Record<string, unknown>, ["type"]) &&
    (value as { type?: unknown }).type === WORKER_START_MESSAGE_TYPE
  );
}

function createWorkerIpcLifetime(): WorkerCommandLifetime {
  if (!process.connected || !process.channel || typeof process.send !== "function") {
    throw new Error("internal worker IPC mode requires a connected Node IPC channel");
  }
  const abortController = new AbortController();
  let disposed = false;
  let started = false;
  let settled = false;
  let resolveStarted!: (started: boolean) => void;
  let rejectStarted!: (error: Error) => void;
  const startedPromise = new Promise<boolean>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const rejectOrAbort = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectStarted(error);
      return;
    }
    abortController.abort(error);
  };
  const onMessage = (message: unknown) => {
    if (disposed) {
      return;
    }
    if (!isWorkerStartMessage(message) || settled) {
      rejectOrAbort(new Error("invalid internal worker IPC start message"));
      return;
    }
    started = true;
    settled = true;
    resolveStarted(true);
  };
  const onDisconnect = () => {
    if (disposed) {
      return;
    }
    if (!settled) {
      settled = true;
      resolveStarted(false);
      return;
    }
    if (started) {
      abortController.abort(new Error("worker supervisor lifetime ended"));
    }
  };
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  return {
    started: startedPromise,
    signal: abortController.signal,
    reportConnectionFailure: (cause) => {
      if (disposed || !process.connected || typeof process.send !== "function") {
        return;
      }
      const message: NodeWorkerConnectionFailureMessage = {
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: cause ?? null,
      };
      try {
        process.send(message, () => {});
      } catch {
        // The disconnect handler owns worker shutdown when the supervisor is gone.
      }
    },
    terminateOwnedTree: () => {
      signalProcessTree(process.pid, "SIGKILL", {
        detached: process.platform !== "win32",
      });
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (process.connected) {
        try {
          process.disconnect?.();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_DISCONNECTED") {
            throw error;
          }
        }
      }
    },
  };
}

/** Runs the worker-only process entry without loading the general CLI command tree. */
export async function runWorkerProcess(
  options: {
    internalWorkerIpc?: boolean;
    managed?: boolean;
    browserRuntime?: WorkerBrowserRuntime;
  } = {},
): Promise<void> {
  // Stdout belongs to the worker result; diagnostics stay on stderr through process shutdown.
  routeLogsToStderr();
  enableConsoleCapture();
  await runWorkerCommand({
    input: process.stdin,
    output: process.stdout,
    ...(options.managed ? { managed: true } : {}),
    ...(options.internalWorkerIpc ? { lifetime: createWorkerIpcLifetime() } : {}),
    ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
  });
}
