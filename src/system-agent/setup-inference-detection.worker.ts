import { parentPort, workerData } from "node:worker_threads";
import { detectSetupInference } from "./setup-inference-detect.js";

if (!parentPort) {
  throw new Error("setup inference detection worker requires a parent port");
}

const port = parentPort;

try {
  const agentId =
    workerData && typeof workerData === "object" && typeof workerData.agentId === "string"
      ? workerData.agentId
      : undefined;
  const detection = await detectSetupInference(
    { onPartial: (partial) => port.postMessage({ type: "partial", detection: partial }) },
    agentId,
  );
  port.postMessage({ type: "result", detection });
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.close();
}
