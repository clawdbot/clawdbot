import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace-default.js";
import { detectAmbientInferenceBackends } from "../commands/onboard-inference-ambient.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import { resolveSetupInferenceCandidateBrandId } from "./setup-inference-brand.js";
import type { SetupInferenceDetection } from "./setup-inference.js";

const SETUP_INFERENCE_DETECTION_TIMEOUT_MS = 10_000;

const log = createSubsystemLogger("system-agent/setup-inference-detection");

class SetupInferenceDetectionTimeoutError extends Error {
  override name = "SetupInferenceDetectionTimeoutError";

  constructor(timeoutMs: number) {
    super(
      `Checking this Gateway for AI access timed out after ${timeoutMs / 1_000}s. ` +
        "The Gateway may be busy — try again.",
    );
  }
}

type DetectionWorkerMessage =
  | { type: "partial"; detection: SetupInferenceDetection }
  | { type: "result"; detection: SetupInferenceDetection }
  | { ok: false; error: string };

type DetectionWorkerOptions = {
  timeoutMs?: number;
  workerUrl?: URL;
  workerData?: WorkerOptions["workerData"];
  fallbackEnv?: NodeJS.ProcessEnv;
};

let inFlightDetection: Promise<SetupInferenceDetection> | undefined;
let workerShutdown: Promise<void> | undefined;

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

function withAmbientCandidates(
  detection: SetupInferenceDetection,
  env: NodeJS.ProcessEnv,
): SetupInferenceDetection {
  const existing = new Set(
    detection.candidates.map((candidate) => `${candidate.kind}\0${candidate.modelRef}`),
  );
  const ambient = detectAmbientInferenceBackends(env)
    .filter((candidate) => !existing.has(`${candidate.kind}\0${candidate.modelRef}`))
    .map((candidate) => {
      const brandId = resolveSetupInferenceCandidateBrandId(candidate);
      return Object.assign(candidate, brandId ? { brandId } : {}, { recommended: false as const });
    });
  if (ambient.length === 0) {
    return detection;
  }
  return { ...detection, candidates: [...detection.candidates, ...ambient] };
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
          `Setup inference detection timed out after ${timeoutMs}ms; using partial signal if available.`,
        );
        const env = options.fallbackEnv ?? process.env;
        const detection = withAmbientCandidates(
          partialDetection ?? createUndetectedFallback(),
          env,
        );
        if (detection.candidates.length > 0 || detection.unavailableCandidates.length > 0) {
          resolve(detection);
          return;
        }
        reject(new SetupInferenceDetectionTimeoutError(timeoutMs));
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
  // A native provider probe can delay Worker termination. Wait for exit before
  // retrying so repeat UI requests neither stack threads nor reuse stale results.
  if (workerShutdown) {
    await workerShutdown;
    return await detectSetupInferenceIsolated(options);
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
