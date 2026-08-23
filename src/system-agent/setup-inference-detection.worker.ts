import { parentPort, workerData } from "node:worker_threads";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import type { SetupInferenceDetection } from "./setup-inference-core.js";
import { detectSetupInference, listManualSetupInferenceOptions } from "./setup-inference-detect.js";

if (!parentPort) {
  throw new Error("setup inference detection worker requires a parent port");
}

const port = parentPort;

try {
  const agentId =
    workerData && typeof workerData === "object" && typeof workerData.agentId === "string"
      ? workerData.agentId
      : undefined;
  const manual = await listManualSetupInferenceOptions({}, agentId);
  const partial: SetupInferenceDetection = {
    candidates: [],
    unavailableCandidates: [],
    recommendedInstalls: listRecommendedToolInstalls(),
    ...manual,
  };
  port.postMessage({
    type: "partial",
    detection: partial,
  });
  const detection = await detectSetupInference({}, agentId);
  port.postMessage({ type: "result", detection });
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.close();
}
