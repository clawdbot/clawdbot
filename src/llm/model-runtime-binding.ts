import type { LlmRuntime } from "@openclaw/ai";
import type { Model } from "./types.js";

export type ModelCompletionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const MODEL_LLM_RUNTIME = Symbol("openclaw.modelLlmRuntime");
const streamLlmRuntimes = new WeakMap<object, LlmRuntime>();

type RuntimeBoundModel = Model & {
  [MODEL_LLM_RUNTIME]?: {
    runtime: LlmRuntime;
    completionTransport?: Model;
    runCompletion?: ModelCompletionRunner;
  };
};

/** Carries the prepared lifecycle runtime without changing the serialized model shape. */
export function bindModelLlmRuntime(
  model: Model,
  runtime: LlmRuntime,
  completionTransport?: Model,
  runCompletion?: ModelCompletionRunner,
): Model {
  const bound: RuntimeBoundModel = { ...model };
  Object.defineProperty(bound, MODEL_LLM_RUNTIME, {
    value: { runtime, completionTransport, runCompletion },
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

export function getModelCompletionRunner(
  model: RuntimeBoundModel,
): ModelCompletionRunner | undefined {
  return model[MODEL_LLM_RUNTIME]?.runCompletion;
}

/** Associates a prepared stream entry point with the runtime that owns it. */
export function bindStreamLlmRuntime(streamFn: object, runtime: LlmRuntime): void {
  streamLlmRuntimes.set(streamFn, runtime);
}

export function getStreamLlmRuntime(streamFn: object | undefined): LlmRuntime | undefined {
  return streamFn ? streamLlmRuntimes.get(streamFn) : undefined;
}
