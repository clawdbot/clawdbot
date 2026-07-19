import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace-default.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import type { SetupInferenceDetection } from "./setup-inference.js";

const SETUP_INFERENCE_DETECTION_TIMEOUT_MS = 10_000;

const log = createSubsystemLogger("system-agent/setup-inference-detection");

type DetectionWorkerMessage =
  | { type: "partial"; detection: SetupInferenceDetection }
  | { type: "result"; detection: SetupInferenceDetection }
  | { ok: false; error: string };

type DetectionWorkerOptions = {
  timeoutMs?: number;
  workerUrl?: URL;
  workerData?: WorkerOptions["workerData"];
  fallback?: () => Promise<SetupInferenceDetection>;
};

let inFlightDetection: Promise<SetupInferenceDetection> | undefined;
let workerShutdown: Promise<void> | undefined;
let workerShutdownResult: SetupInferenceDetection | undefined;

function trackWorkerShutdown(worker: Worker): void {
  const current = worker.terminate().then(
    () => undefined,
    (error: unknown) => {
      log.warn(`Setup inference detection worker termination failed: ${String(error)}`);
    },
  );
  workerShutdown = current;
  void current.finally(() => {
    if (workerShutdown === current) {
      workerShutdown = undefined;
      workerShutdownResult = undefined;
    }
  });
}

function resolveDetectionWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "system-agent", "setup-inference-detection.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./setup-inference-detection.worker${extension}`, currentModuleUrl);
}

function parseDetectionWorkerMessage(value: unknown): DetectionWorkerMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (
    (message.type === "partial" || message.type === "result") &&
    message.detection &&
    typeof message.detection === "object"
  ) {
    return message as DetectionWorkerMessage;
  }
  if (message.ok === false && typeof message.error === "string") {
    return message as DetectionWorkerMessage;
  }
  return undefined;
}

function createUndetectedFallback(): SetupInferenceDetection {
  // This fallback must stay independent of the detection/plugin graph. The worker
  // supplies richer partial data when that graph loads before the deadline.
  return {
    candidates: [],
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    recommendedInstalls: listRecommendedToolInstalls(),
    workspace: DEFAULT_AGENT_WORKSPACE_DIR,
    setupComplete: false,
  };
}

async function runDetectionWorker(
  options: DetectionWorkerOptions = {},
): Promise<SetupInferenceDetection> {
  const workerUrl = options.workerUrl ?? resolveDetectionWorkerUrl();
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  const worker = new Worker(workerUrl, {
    execArgv,
    ...(options.workerData === undefined ? {} : { workerData: options.workerData }),
  });
  const timeoutMs = options.timeoutMs ?? SETUP_INFERENCE_DETECTION_TIMEOUT_MS;

  return await new Promise<SetupInferenceDetection>((resolve, reject) => {
    let settled = false;
    let partialDetection: SetupInferenceDetection | undefined;
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      // terminate() is asynchronous; keep teardown errors from becoming uncaught events.
      worker.on("error", () => undefined);
      trackWorkerShutdown(worker);
      finish();
    };
    worker.on("message", (value: unknown) => {
      const message = parseDetectionWorkerMessage(value);
      if (message && "type" in message && message.type === "partial") {
        partialDetection = message.detection;
        return;
      }
      settle(() => {
        if (!message) {
          reject(new Error("setup inference detection worker returned an invalid result"));
          return;
        }
        if ("ok" in message) {
          reject(new Error(message.error));
          return;
        }
        workerShutdownResult = message.detection;
        resolve(message.detection);
      });
    });
    worker.once("error", (error) =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() =>
          reject(new Error(`setup inference detection worker exited with code ${code}`)),
        );
      } else {
        settle(() => reject(new Error("setup inference detection worker exited without results")));
      }
    });
    const timer = setTimeout(() => {
      settle(() => {
        log.warn(
          `Setup inference detection timed out after ${timeoutMs}ms; returning partial detection.`,
        );
        if (options.fallback) {
          void options.fallback().then(resolve, reject);
          return;
        }
        const detection = partialDetection ?? createUndetectedFallback();
        workerShutdownResult = detection;
        resolve(detection);
      });
    }, timeoutMs);
    // Installing a message listener references the underlying MessagePort.
    // Unref only after all listeners exist so timed-out workers cannot pin shutdown.
    worker.unref();
  });
}

/** Coalesce read-only detection and isolate native/plugin discovery from Gateway liveness. */
export async function detectSetupInferenceIsolated(
  options: DetectionWorkerOptions = {},
): Promise<SetupInferenceDetection> {
  if (inFlightDetection) {
    return await inFlightDetection;
  }
  // A native provider probe can delay Worker termination. Reuse the bounded
  // result until exit instead of allowing repeat UI requests to stack threads.
  if (workerShutdown) {
    return workerShutdownResult ?? createUndetectedFallback();
  }
  const current = runDetectionWorker(options);
  inFlightDetection = current;
  try {
    return await current;
  } finally {
    if (inFlightDetection === current) {
      inFlightDetection = undefined;
    }
  }
}
