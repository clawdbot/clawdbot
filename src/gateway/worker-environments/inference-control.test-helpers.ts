import { registerWorkerInferenceSessionDrain } from "./inference-control-internal.js";

export function createWorkerInferenceDrainService(
  beginDrain: Parameters<typeof registerWorkerInferenceSessionDrain>[1],
  service: object = {},
) {
  const registered = {
    ...service,
    cancelInferenceForSession: () => [],
    hasInferenceForSession: () => false,
    resolveInferenceSessionForRunId: () => undefined,
  };
  registerWorkerInferenceSessionDrain(registered, beginDrain);
  return registered;
}
