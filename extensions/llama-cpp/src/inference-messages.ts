import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, StopReason, Usage } from "openclaw/plugin-sdk/llm";

export function zeroCostUsage(input = 0, output = 0): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildMessage(params: {
  model: Parameters<StreamFn>[0];
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage?: Usage;
  errorMessage?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    stopReason: params.stopReason,
    usage: params.usage ?? zeroCostUsage(),
    timestamp: Date.now(),
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
  };
}

export function runtimeUnavailableErrorMessage(restartRequired: boolean): string {
  return restartRequired
    ? "llama.cpp runtime stopped after native cleanup failed. Fully stop the managed Gateway service or foreground Gateway process, then start it again. An in-process restart cannot recover native resources."
    : "llama.cpp runtime is stopping";
}

export function runtimeUnavailableMessage(
  model: Parameters<StreamFn>[0],
  restartRequired: boolean,
): AssistantMessage {
  return buildMessage({
    model,
    content: [],
    stopReason: "error",
    errorMessage: runtimeUnavailableErrorMessage(restartRequired),
  });
}
