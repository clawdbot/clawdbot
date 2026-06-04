// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

type ModelsJsonState = {
  writeLocks: Map<string, Promise<void>>;
  readyCache: Map<
    string,
    Promise<{ fingerprint: string; result: { agentDir: string; wrote: boolean } }>
  >;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeLocks: new Map<string, Promise<void>>(),
      readyCache: new Map<
        string,
        Promise<{ fingerprint: string; result: { agentDir: string; wrote: boolean } }>
      >(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();

/** Clear models.json write/ready caches for tests. */
export function resetModelsJsonReadyCacheForTest(): void {
  MODELS_JSON_STATE.writeLocks.clear();
  MODELS_JSON_STATE.readyCache.clear();
}
