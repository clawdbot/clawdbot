import type { AssistantMessage, Model, StreamFn } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { ResolvedEmbeddedAgentRunBudget } from "../agent-scope.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export type EmbeddedAgentRunBudgetTerminalReason =
  | "completed"
  | "model_turns"
  | "tool_calls"
  | "provider_attempts"
  | "output_tokens"
  | "timeout"
  | "canceled";

export type EmbeddedAgentRunBudgetCounters = {
  modelTurns: number;
  toolCalls: number;
  providerAttempts: number;
  outputTokens: number;
};

export type EmbeddedAgentRunBudgetEnvelope = {
  version: 1;
  completed: boolean;
  terminalReason: EmbeddedAgentRunBudgetTerminalReason;
  counters: EmbeddedAgentRunBudgetCounters;
  limits: ResolvedEmbeddedAgentRunBudget;
  durationMs: number;
  retryable: boolean;
};

export function applyRunBudgetEnvelope(
  result: EmbeddedAgentRunResult,
  envelope: EmbeddedAgentRunBudgetEnvelope,
): EmbeddedAgentRunResult {
  if (envelope.completed) {
    return { ...result, meta: { ...result.meta, runBudget: envelope } };
  }
  return {
    ...result,
    payloads: [],
    meta: {
      ...result.meta,
      aborted: true,
      finalAssistantVisibleText: undefined,
      finalAssistantRawText: undefined,
      runBudget: envelope,
    },
  };
}

export class EmbeddedAgentRunBudgetExceededError extends Error {
  constructor(readonly terminalReason: Exclude<EmbeddedAgentRunBudgetTerminalReason, "completed">) {
    super(`embedded agent run stopped: ${terminalReason}`);
    this.name = "EmbeddedAgentRunBudgetExceededError";
  }
}

function resolveRetryable(reason: EmbeddedAgentRunBudgetTerminalReason): boolean {
  return reason === "provider_attempts" || reason === "timeout";
}

function abortReasonFor(reason: Exclude<EmbeddedAgentRunBudgetTerminalReason, "completed">): Error {
  const error = new EmbeddedAgentRunBudgetExceededError(reason);
  if (reason === "timeout") {
    error.name = "TimeoutError";
  } else if (reason === "canceled") {
    error.name = "AbortError";
  }
  return error;
}

/**
 * Owns one run's sticky terminal state and synchronous pre-dispatch reservations.
 * JavaScript execution is single-threaded, so each check-and-increment is atomic
 * with respect to parallel tool callbacks in the same process.
 */
export class EmbeddedAgentRunBudgetController {
  readonly signal: AbortSignal;
  readonly limits: ResolvedEmbeddedAgentRunBudget;

  private readonly abortController = new AbortController();
  private readonly startedAtMs: number;
  private readonly timeout: NodeJS.Timeout;
  private readonly callerAbortSignal?: AbortSignal;
  private terminalReason?: EmbeddedAgentRunBudgetTerminalReason;
  private counters: EmbeddedAgentRunBudgetCounters = {
    modelTurns: 0,
    toolCalls: 0,
    providerAttempts: 0,
    outputTokens: 0,
  };

  constructor(input: {
    limits: ResolvedEmbeddedAgentRunBudget;
    callerAbortSignal?: AbortSignal;
    startedAtMs?: number;
  }) {
    this.limits = input.limits;
    this.callerAbortSignal = input.callerAbortSignal;
    this.startedAtMs = input.startedAtMs ?? Date.now();
    this.signal = this.abortController.signal;

    this.timeout = setTimeout(() => this.stop("timeout"), this.limits.maxDurationMs);
    this.timeout.unref?.();

    if (this.callerAbortSignal?.aborted) {
      this.stop("canceled");
    } else {
      this.callerAbortSignal?.addEventListener("abort", this.onCallerAbort, { once: true });
    }
  }

  private readonly onCallerAbort = () => this.stop("canceled");

  private stop(reason: Exclude<EmbeddedAgentRunBudgetTerminalReason, "completed">): void {
    if (this.terminalReason) {
      return;
    }
    this.terminalReason = reason;
    clearTimeout(this.timeout);
    this.abortController.abort(abortReasonFor(reason));
  }

  private enforceDeadline(): void {
    if (!this.terminalReason && Date.now() - this.startedAtMs >= this.limits.maxDurationMs) {
      this.stop("timeout");
    }
  }

  private throwIfStopped(): void {
    this.enforceDeadline();
    if (this.terminalReason && this.terminalReason !== "completed") {
      throw new EmbeddedAgentRunBudgetExceededError(this.terminalReason);
    }
  }

  /** Reserves one model invocation and its provider dispatch before either starts. */
  reserveModelInvocation(): void {
    this.throwIfStopped();
    if (this.counters.modelTurns >= this.limits.maxModelTurns) {
      this.stop("model_turns");
      throw new EmbeddedAgentRunBudgetExceededError("model_turns");
    }
    if (this.counters.providerAttempts >= this.limits.maxProviderAttempts) {
      this.stop("provider_attempts");
      throw new EmbeddedAgentRunBudgetExceededError("provider_attempts");
    }
    this.counters.modelTurns += 1;
    this.counters.providerAttempts += 1;
  }

  /** Reserves one tool execution immediately before the tool implementation starts. */
  reserveToolCall(): void {
    this.throwIfStopped();
    if (this.counters.toolCalls >= this.limits.maxToolCalls) {
      this.stop("tool_calls");
      throw new EmbeddedAgentRunBudgetExceededError("tool_calls");
    }
    this.counters.toolCalls += 1;
  }

  remainingOutputTokens(): number {
    return Math.max(0, this.limits.maxOutputTokens - this.counters.outputTokens);
  }

  /**
   * Accounts one terminal provider message before it reaches the tool loop.
   * Missing/invalid usage consumes the remaining allowance and fails closed.
   */
  recordOutputTokens(outputTokens: unknown): boolean {
    this.throwIfStopped();
    if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
      this.counters.outputTokens = this.limits.maxOutputTokens;
      this.stop("output_tokens");
      return false;
    }
    const next = this.counters.outputTokens + (outputTokens as number);
    this.counters.outputTokens = Math.min(next, this.limits.maxOutputTokens);
    if (next >= this.limits.maxOutputTokens) {
      this.stop("output_tokens");
      return false;
    }
    return true;
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined;
  }

  complete(): EmbeddedAgentRunBudgetEnvelope {
    this.enforceDeadline();
    if (!this.terminalReason) {
      this.terminalReason = "completed";
      clearTimeout(this.timeout);
    }
    return this.snapshot();
  }

  snapshot(): EmbeddedAgentRunBudgetEnvelope {
    const terminalReason = this.terminalReason ?? "completed";
    return {
      version: 1,
      completed: terminalReason === "completed",
      terminalReason,
      counters: { ...this.counters },
      limits: { ...this.limits },
      durationMs: Math.max(0, Date.now() - this.startedAtMs),
      retryable: resolveRetryable(terminalReason),
    };
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.callerAbortSignal?.removeEventListener("abort", this.onCallerAbort);
  }
}

function mergeRunBudgetSignal(
  signal: AbortSignal | undefined,
  runBudgetSignal: AbortSignal,
): AbortSignal {
  if (!signal || signal === runBudgetSignal) {
    return signal ?? runBudgetSignal;
  }
  return AbortSignal.any([signal, runBudgetSignal]);
}

function buildStreamFailureMessage(model: Model, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function buildBudgetAbortedMessage(input: {
  model: Model;
  source?: AssistantMessage;
  reason: EmbeddedAgentRunBudgetTerminalReason;
}): AssistantMessage {
  const errorMessage = `embedded agent run stopped: ${input.reason}`;
  if (input.source) {
    return {
      ...input.source,
      content: [],
      stopReason: "aborted",
      errorMessage,
    };
  }
  return {
    role: "assistant",
    content: [],
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage,
    timestamp: Date.now(),
  };
}

/** Wraps the provider boundary with pre-dispatch reservation and usage accounting. */
export function wrapStreamFnWithRunBudget(
  inner: StreamFn,
  controller: EmbeddedAgentRunBudgetController,
): StreamFn {
  return async (model, context, options) => {
    controller.reserveModelInvocation();
    const remainingOutputTokens = controller.remainingOutputTokens();
    const configuredMaxTokens = options?.maxTokens;
    const maxTokens =
      typeof configuredMaxTokens === "number" && Number.isFinite(configuredMaxTokens)
        ? Math.min(configuredMaxTokens, remainingOutputTokens)
        : remainingOutputTokens;
    const innerStream = await inner(model, context, {
      ...options,
      // Provider SDK retries are opaque to the loop owner. Disable them so every
      // actual request crosses the authoritative provider-attempt reservation.
      maxRetries: 0,
      maxTokens,
      signal: mergeRunBudgetSignal(options?.signal, controller.signal),
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of innerStream) {
          if (event.type !== "done" && event.type !== "error") {
            output.push(event);
            continue;
          }
          const message = event.type === "done" ? event.message : event.error;
          if (controller.isTerminal() || !controller.recordOutputTokens(message.usage?.output)) {
            const reason = controller.snapshot().terminalReason;
            output.push({
              type: "error",
              reason: "aborted",
              error: buildBudgetAbortedMessage({ model, source: message, reason }),
            });
            return;
          }
          output.push(event);
        }
        if (controller.isTerminal()) {
          const reason = controller.snapshot().terminalReason;
          output.push({
            type: "error",
            reason: "aborted",
            error: buildBudgetAbortedMessage({ model, reason }),
          });
        } else {
          output.push({
            type: "error",
            reason: "error",
            error: buildStreamFailureMessage(
              model,
              new Error("provider stream ended without a terminal event"),
            ),
          });
        }
      } catch (error) {
        if (!controller.isTerminal()) {
          output.push({
            type: "error",
            reason: "error",
            error: buildStreamFailureMessage(model, error),
          });
          return;
        }
        const reason = controller.snapshot().terminalReason;
        output.push({
          type: "error",
          reason: "aborted",
          error: buildBudgetAbortedMessage({ model, reason }),
        });
      }
    })();
    return output;
  };
}
