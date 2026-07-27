import type { EventEmitter } from "node:events";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isVitestRuntimeEnv } from "../infra/env.js";

const SYSTEM_CA_WARMUP_TIMEOUT_MS = 10_000;
const SYSTEM_CA_WORKER_SOURCE = String.raw`
  const { getCACertificates } = require("node:tls");
  const { parentPort } = require("node:worker_threads");

  try {
    const certificateCount = getCACertificates("default").length;
    parentPort.postMessage({ ok: true, certificateCount });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    parentPort.close();
  }
`;

type SystemCaWarmupWorker = Pick<EventEmitter, "once" | "removeAllListeners"> & {
  terminate: () => Promise<number>;
  unref: () => void;
};

type SystemCaWarmupOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: { warn: (message: string) => void };
  timeoutMs?: number;
  createWorker?: (source: string, options: WorkerOptions) => SystemCaWarmupWorker;
};

type SystemCaWarmupMessage = { ok: true; certificateCount: number } | { ok: false; error: string };

function isSystemCaWarmupMessage(value: unknown): value is SystemCaWarmupMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return message.ok === true
    ? typeof message.certificateCount === "number"
    : message.ok === false && typeof message.error === "string";
}

function isWorkerPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_ACCESS_DENIED"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Warm Node's effective default CA set without blocking the gateway event loop on macOS. */
export async function warmMacOSSystemCaOffMainThread(
  options: SystemCaWarmupOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (
    platform !== "darwin" ||
    (options.env === undefined && options.platform === undefined && isVitestRuntimeEnv(env))
  ) {
    return;
  }

  let worker: SystemCaWarmupWorker;
  try {
    worker = (
      options.createWorker ?? ((source, workerOptions) => new Worker(source, workerOptions))
    )(SYSTEM_CA_WORKER_SOURCE, { eval: true });
  } catch (error) {
    // CA prewarming is an optimization. Node can still load trust settings lazily.
    const reason = isWorkerPermissionDenied(error)
      ? "Node denied worker-thread permission"
      : `worker creation failed: ${describeError(error)}`;
    options.log?.warn(`macOS CA warmup skipped because ${reason}; trust settings will load lazily`);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timeoutMs = options.timeoutMs ?? SYSTEM_CA_WARMUP_TIMEOUT_MS;

    const settle = (warning?: string, terminate = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      // A terminating worker can still report one final error after listener cleanup.
      worker.once("error", () => {});
      if (terminate) {
        void worker.terminate().catch(() => {});
      }
      if (warning) {
        options.log?.warn(warning);
      }
      resolve();
    };

    worker.once("message", (value: unknown) => {
      if (!isSystemCaWarmupMessage(value)) {
        settle(
          "macOS CA warmup returned an invalid result; gateway startup will continue and trust settings will load lazily",
          true,
        );
        return;
      }
      if (!value.ok) {
        settle(
          `macOS CA warmup failed: ${value.error}; gateway startup will continue and trust settings will load lazily`,
          true,
        );
        return;
      }
      settle();
    });
    worker.once("error", (error: Error) => {
      settle(
        `macOS CA warmup worker failed: ${error.message}; gateway startup will continue and trust settings will load lazily`,
      );
    });
    worker.once("exit", (code: number) => {
      settle(
        `macOS CA warmup worker exited before replying (code ${code}); gateway startup will continue and trust settings will load lazily`,
      );
    });

    const timeout = setTimeout(() => {
      settle(
        `macOS CA warmup timed out after ${timeoutMs}ms; gateway startup will continue and trust settings will load lazily`,
        true,
      );
    }, timeoutMs);
    timeout.unref?.();

    // A wedged trustd lookup must not keep an otherwise stopped gateway process alive.
    worker.unref();
  });
}
