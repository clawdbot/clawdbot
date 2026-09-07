// Isolated plugin LLM completion policy validates and dispatches the zero-tool runtime mode.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { IsolatedCompletionResult } from "../../agents/isolated-completion.js";
import { buildConfiguredModelCatalog } from "../../agents/model-selection-shared.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveThinkingProfile } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";
import type { LlmCompleteParams, LlmIsolatedAgentRuntimeCompleteParams } from "./types-core.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function requireIsolatedUserPrompt(params: LlmCompleteParams): string {
  if (
    params.execution?.mode !== "isolated-agent-runtime" ||
    !Array.isArray(params.messages) ||
    params.messages.length !== 1 ||
    params.messages[0]?.role !== "user" ||
    typeof params.messages[0].content !== "string"
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      "Isolated agent-runtime completion requires exactly one user message; pass system instructions through systemPrompt.",
    );
  }
  return params.messages[0].content;
}

export function isIsolatedAgentRuntimeRequest(
  params: LlmCompleteParams,
): params is LlmIsolatedAgentRuntimeCompleteParams {
  return params.execution?.mode === "isolated-agent-runtime";
}

export function assertSupportedExecutionMode(params: LlmCompleteParams): void {
  const execution = (params as { execution?: unknown }).execution;
  if (execution === undefined) {
    return;
  }
  if (
    !execution ||
    typeof execution !== "object" ||
    Array.isArray(execution) ||
    (execution as { mode?: unknown }).mode !== "isolated-agent-runtime"
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      'Plugin LLM completion execution.mode must be "isolated-agent-runtime" when execution is provided.',
    );
  }
}

function resolveIsolatedTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 30_000;
  }
  const timeoutMs = asFiniteNumber(value);
  if (
    timeoutMs === undefined ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      `Isolated agent-runtime completion timeoutMs must be an integer from 1 through ${MAX_TIMER_DELAY_MS}.`,
    );
  }
  return timeoutMs;
}

function assertIsolatedReasoningSupported(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  reasoning: LlmCompleteParams["reasoning"];
}): void {
  if (params.reasoning === undefined) {
    return;
  }
  const catalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const profile = resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    agentRuntime: resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: params.provider,
      modelId: params.model,
    }),
    ...(catalog.length > 0 ? { catalog } : {}),
  });
  if (profile.levels.some((level) => level.id === params.reasoning)) {
    return;
  }
  throw completionError(
    "LLM_ISOLATED_INPUT_REJECTED",
    `Thinking level "${params.reasoning}" is not supported for ${params.provider}/${params.model}. Use one of: ${profile.levels.map((level) => level.label).join(", ")}.`,
  );
}

export async function runIsolatedAgentRuntimeCompletion(params: {
  request: LlmIsolatedAgentRuntimeCompleteParams;
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  authProfileId?: string;
}): Promise<IsolatedCompletionResult> {
  const prompt = requireIsolatedUserPrompt(params.request);
  const timeoutMs = resolveIsolatedTimeoutMs(params.request.execution.timeoutMs);
  assertIsolatedReasoningSupported({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    reasoning: params.request.reasoning,
  });
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(params.request.signal?.reason);
  if (params.request.signal?.aborted) {
    throw completionError("LLM_COMPLETION_ABORTED", "Plugin LLM completion was aborted.");
  }
  params.request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Isolated completion timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timer.unref?.();
  let rejectOnAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => {
      const reason = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error("Isolated completion was aborted."));
    };
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    const operation = (async () => {
      const { runIsolatedCompletion } = await import("../../agents/isolated-completion.js");
      return await runIsolatedCompletion({
        config: params.cfg,
        provider: params.provider,
        model: params.model,
        authProfileId: params.authProfileId,
        agentId: params.agentId,
        systemPrompt: params.request.systemPrompt ?? "",
        prompt,
        timeoutMs,
        abortSignal: controller.signal,
        thinkLevel: params.request.reasoning,
        streamParams: {
          maxTokens: asFiniteNumber(params.request.maxTokens),
          temperature: asFiniteNumber(params.request.temperature),
        },
      });
    })();
    return await Promise.race([operation, abortPromise]);
  } catch (error) {
    if (timedOut) {
      throw completionError(
        "LLM_COMPLETION_TIMEOUT",
        `Plugin LLM completion timed out after ${timeoutMs}ms.`,
        error,
      );
    }
    if (params.request.signal?.aborted) {
      throw completionError("LLM_COMPLETION_ABORTED", "Plugin LLM completion was aborted.", error);
    }
    const isolatedError = error as { code?: unknown; message?: unknown };
    if (isolatedError.code === "unsupported") {
      throw completionError(
        "LLM_ISOLATED_UNSUPPORTED",
        typeof isolatedError.message === "string"
          ? isolatedError.message
          : "Configured agent runtime does not support isolated completion.",
        error,
      );
    }
    if (isolatedError.code === "runtime-unavailable") {
      throw completionError(
        "LLM_RUNTIME_UNAVAILABLE",
        typeof isolatedError.message === "string"
          ? isolatedError.message
          : "Configured agent runtime is unavailable.",
        error,
      );
    }
    if (isolatedError.code === "input-rejected") {
      throw completionError(
        "LLM_ISOLATED_INPUT_REJECTED",
        typeof isolatedError.message === "string"
          ? isolatedError.message
          : "Isolated completion input was rejected.",
        error,
      );
    }
    if (isolatedError.code === "output-rejected") {
      throw completionError(
        "LLM_COMPLETION_OUTPUT_REJECTED",
        typeof isolatedError.message === "string"
          ? isolatedError.message
          : "Isolated completion output was rejected.",
        error,
      );
    }
    throw completionError("LLM_COMPLETION_FAILED", "Plugin LLM completion failed.", error);
  } finally {
    clearTimeout(timer);
    if (rejectOnAbort) {
      controller.signal.removeEventListener("abort", rejectOnAbort);
    }
    params.request.signal?.removeEventListener("abort", abortFromCaller);
  }
}
