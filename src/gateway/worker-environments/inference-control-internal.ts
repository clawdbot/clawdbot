export type WorkerInferenceSessionDrain = {
  drained: Promise<void>;
  hasWork(): boolean;
  release(): void;
};

type BeginWorkerInferenceSessionDrain = (sessionId: string) => WorkerInferenceSessionDrain;

// Session lifecycle needs a stronger control without widening the inferred public service shape.
// The weak registration follows the concrete service instance's lifetime.
const sessionDrainByService = new WeakMap<object, BeginWorkerInferenceSessionDrain>();

export function registerWorkerInferenceSessionDrain(
  service: object,
  beginDrain: BeginWorkerInferenceSessionDrain,
): void {
  sessionDrainByService.set(service, beginDrain);
}

export function beginWorkerInferenceSessionDrain(
  service: unknown,
  sessionId: string,
): WorkerInferenceSessionDrain | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionDrainByService.get(service)?.(sessionId);
}
