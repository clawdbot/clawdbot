import type { EventEmitter } from "node:events";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isVitestRuntimeEnv } from "../infra/env.js";

const SYSTEM_CA_WARMUP_WARNING_MS = 10_000;
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
  unref: () => void;
};

type SystemCaWarmupOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: { warn: (message: string) => void };
  warningMs?: number;
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
    // Node's permission model can deny Worker construction. Fall back to Node's lazy CA
    // loading instead of turning an optional event-loop warmup into a startup requirement.
    if (!isWorkerPermissionDenied(error)) {
      throw error;
    }
    options.log?.warn(
      "macOS CA warmup skipped because Node denied worker-thread permission; trust settings will load lazily",
    );
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const warningTimer = setTimeout(() => {
      options.log?.warn(
        "macOS CA warmup is still waiting for default trust settings; gateway post-attach startup remains deferred",
      );
    }, options.warningMs ?? SYSTEM_CA_WARMUP_WARNING_MS);
    warningTimer.unref?.();

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(warningTimer);
      worker.removeAllListeners();
      finish();
    };

    worker.once("message", (value: unknown) => {
      settle(() => {
        if (!isSystemCaWarmupMessage(value)) {
          reject(new Error("macOS system CA warmup worker returned an invalid result"));
          return;
        }
        if (!value.ok) {
          reject(new Error(value.error));
          return;
        }
        resolve();
      });
    });
    worker.once("error", (error: Error) => settle(() => reject(error)));
    worker.once("exit", (code: number) => {
      settle(() =>
        reject(new Error(`macOS system CA warmup worker exited before replying (code ${code})`)),
      );
    });

    // A wedged trustd lookup must not keep an otherwise stopped gateway process alive.
    worker.unref();
  });
}
