import type { LlmRuntime } from "@openclaw/ai";
import type { Model } from "./types.js";

const MODEL_LLM_RUNTIME = Symbol("openclaw.modelLlmRuntime");
const streamLlmRuntimes = new WeakMap<object, LlmRuntime>();

type RuntimeBoundModel = Model & {
  [MODEL_LLM_RUNTIME]?: {
    runtime: LlmRuntime;
    completionTransport?: Model;
  };
};

/** Carries the prepared lifecycle runtime without changing the serialized model shape. */
export function bindModelLlmRuntime(
  model: Model,
  runtime: LlmRuntime,
  completionTransport?: Model,
): Model {
  const bound: RuntimeBoundModel = { ...model };
  Object.defineProperty(bound, MODEL_LLM_RUNTIME, {
    value: { runtime, completionTransport },
    enumerable: false,
  });
  return bound;
}

export function getModelLlmRuntime(model: RuntimeBoundModel): LlmRuntime | undefined {
  return model[MODEL_LLM_RUNTIME]?.runtime;
}

export function getModelCompletionTransport(model: RuntimeBoundModel): Model | undefined {
  return model[MODEL_LLM_RUNTIME]?.completionTransport;
}

/** Associates a prepared stream entry point with the runtime that owns it. */
export function bindStreamLlmRuntime(streamFn: object, runtime: LlmRuntime): void {
  streamLlmRuntimes.set(streamFn, runtime);
}

export function getStreamLlmRuntime(streamFn: object | undefined): LlmRuntime | undefined {
  return streamFn ? streamLlmRuntimes.get(streamFn) : undefined;
}
