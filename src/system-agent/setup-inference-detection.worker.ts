import { parentPort } from "node:worker_threads";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import {
  detectSetupInference,
  listManualSetupInferenceOptions,
  type SetupInferenceDetection,
} from "./setup-inference.js";

if (!parentPort) {
  throw new Error("setup inference detection worker requires a parent port");
}

const port = parentPort;

try {
  const manual = await listManualSetupInferenceOptions();
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
  const detection = await detectSetupInference();
  port.postMessage({ type: "result", detection });
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.close();
}
