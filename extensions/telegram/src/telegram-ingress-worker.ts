// Telegram plugin module implements telegram ingress worker behavior.
import { Worker } from "node:worker_threads";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";

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

export type TelegramIngressWorkerHandle = {
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

export const createTelegramIngressWorker: TelegramIngressWorkerFactory = (options) => {
  const listeners = new Set<(message: TelegramIngressWorkerMessage) => void>();
  const worker = new Worker(new URL("./telegram-ingress-worker.runtime.js", import.meta.url), {
    workerData: options,
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
      Reflect.apply(Reflect.get(worker, "postMessage") as (value: unknown) => void, worker, [
        { type: "stop" } satisfies TelegramIngressWorkerCommand,
      ]);
      const timeout = setTimeout(() => {
        void worker.terminate();
      }, 15_000);
      timeout.unref?.();
      try {
        await taskPromise.catch(() => undefined);
      } finally {
        clearTimeout(timeout);
      }
    },
    task() {
      return taskPromise;
    },
  };
};
