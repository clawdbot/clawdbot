// Telegram plugin module implements telegram ingress worker behavior.
import { Worker } from "node:worker_threads";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";

export const TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER = "openclaw.telegram-ingress-worker";
const TELEGRAM_INGRESS_WORKER_STOP_GRACE_MS = 2_000;

export type TelegramIngressWorkerMessage =
  | {
      type: "poll-start";
      offset: number | null;
      startedAt: number;
    }
  | {
      type: "poll-success";
      offset: number | null;
      count: number;
      finishedAt: number;
    }
  | {
      type: "poll-error";
      message: string;
      /** Telegram Bot API error_code (e.g. 409 for getUpdates conflicts). */
      errorCode?: number;
      /** Actual server-directed flood wait currently being honored by the worker. */
      retryAfterMs?: number;
      finishedAt: number;
    }
  | {
      type: "spooled";
      updateId: number;
      queued: number;
    }
  | {
      type: "update";
      requestId: string;
      update: unknown;
      queued: number;
    };

export type TelegramIngressWorkerCommand =
  | {
      type: "stop";
    }
  | {
      type: "spool-ack";
      requestId: string;
      result:
        | {
            ok: true;
            updateId: number;
          }
        | {
            ok: false;
            message: string;
          };
    };

export type TelegramIngressWorkerOptions = {
  token: string;
  accountId: string;
  initialUpdateId: number | null;
  spoolDir: string;
  apiRoot?: string;
  timeoutSeconds?: number;
  network?: TelegramNetworkConfig;
  proxy?: string;
};

type TelegramIngressWorkerHandle = {
  onMessage(listener: (message: TelegramIngressWorkerMessage) => void): () => void;
  ackSpooledUpdate?(
    requestId: string,
    result:
      | {
          ok: true;
          updateId: number;
        }
      | {
          ok: false;
          message: string;
        },
  ): void;
  stop(): Promise<void>;
  task(): Promise<void>;
};

export type TelegramIngressWorkerFactory = (
  options: TelegramIngressWorkerOptions,
) => TelegramIngressWorkerHandle;

async function stopTelegramIngressWorker(params: {
  requestStop: () => void;
  task: Promise<void>;
  terminate: () => Promise<number>;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forcedTermination = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      void params.terminate().then(() => resolve(), reject);
    }, TELEGRAM_INGRESS_WORKER_STOP_GRACE_MS);
    timeout.unref?.();
  });
  try {
    params.requestStop();
    // Keep the cooperative close path, but finish inside the host channel's
    // stop budget. Forced termination is replay-safe because updates advance
    // only after the parent durably spools and acknowledges them.
    await Promise.race([params.task.catch(() => undefined), forcedTermination]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export const createTelegramIngressWorker: TelegramIngressWorkerFactory = (options) => {
  const listeners = new Set<(message: TelegramIngressWorkerMessage) => void>();
  const worker = new Worker(new URL("./telegram-ingress-worker.runtime.js", import.meta.url), {
    workerData: { ...options, runtime: TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER },
  });
  const taskPromise = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Telegram ingress worker exited with code ${code}`));
    });
  });
  worker.on("message", (message: TelegramIngressWorkerMessage) => {
    for (const listener of listeners) {
      listener(message);
    }
  });

  return {
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ackSpooledUpdate(requestId, result) {
      try {
        Reflect.apply(Reflect.get(worker, "postMessage") as (value: unknown) => void, worker, [
          { type: "spool-ack", requestId, result } satisfies TelegramIngressWorkerCommand,
        ]);
      } catch {
        // Worker may have exited after the parent committed the queue write.
      }
    },
    async stop() {
      await stopTelegramIngressWorker({
        requestStop: () => {
          Reflect.apply(Reflect.get(worker, "postMessage") as (value: unknown) => void, worker, [
            { type: "stop" } satisfies TelegramIngressWorkerCommand,
          ]);
        },
        task: taskPromise,
        terminate: () => worker.terminate(),
      });
    },
    task() {
      return taskPromise;
    },
  };
};
