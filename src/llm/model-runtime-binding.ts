import type { LlmRuntime } from "@openclaw/ai";
import type { Model } from "./types.js";

const MODEL_LLM_RUNTIME = Symbol("openclaw.modelLlmRuntime");
const streamLlmRuntimes = new WeakMap<object, LlmRuntime>();

type RuntimeBoundModel = Model & {
  [MODEL_LLM_RUNTIME]?: LlmRuntime;
};

/** Carries the prepared lifecycle runtime without changing the serialized model shape. */
export function bindModelLlmRuntime(model: Model, runtime: LlmRuntime): Model {
  const bound = { ...model } as RuntimeBoundModel;
  Object.defineProperty(bound, MODEL_LLM_RUNTIME, {
    value: runtime,
    enumerable: false,
  });
  return bound;
}

export function getModelLlmRuntime(model: Model): LlmRuntime | undefined {
  return (model as RuntimeBoundModel)[MODEL_LLM_RUNTIME];
}

/** Associates a prepared stream entry point with the runtime that owns it. */
export function bindStreamLlmRuntime(streamFn: object, runtime: LlmRuntime): void {
  streamLlmRuntimes.set(streamFn, runtime);
}

export function getStreamLlmRuntime(streamFn: object | undefined): LlmRuntime | undefined {
  return streamFn ? streamLlmRuntimes.get(streamFn) : undefined;
}
