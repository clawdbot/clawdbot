import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";

export function resetModelsJsonReadyCacheForTest(): void {
  MODELS_JSON_STATE.writeQueue = new KeyedAsyncQueue();
  MODELS_JSON_STATE.readyCache.clear();
}
