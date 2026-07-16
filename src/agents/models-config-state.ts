// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

export type ModelsJsonReadyResult = {
  agentDir: string;
  wrote: boolean;
};

export type ModelsJsonReadyState = {
  fingerprint: string;
  result: ModelsJsonReadyResult;
};

type ModelsJsonState = {
  writeQueue: KeyedAsyncQueue;
  readyCache: Map<string, Promise<ModelsJsonReadyState>>;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeQueue: new KeyedAsyncQueue(),
      readyCache: new Map<string, Promise<ModelsJsonReadyState>>(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();
