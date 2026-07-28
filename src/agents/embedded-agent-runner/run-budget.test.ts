import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model, StreamFn } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { ResolvedEmbeddedAgentRunBudget } from "../agent-scope.js";
import {
  EmbeddedAgentRunBudgetController,
  EmbeddedAgentRunBudgetExceededError,
  wrapStreamFnWithRunBudget,
} from "./run-budget.js";

function createLimits(
  overrides: Partial<ResolvedEmbeddedAgentRunBudget> = {},
): ResolvedEmbeddedAgentRunBudget {
  return {
    maxModelTurns: 2,
    maxToolCalls: 2,
    maxProviderAttempts: 2,
    maxOutputTokens: 10,
    maxDurationMs: 1_000,
    ...overrides,
  };
}

function expectBudgetReason(fn: () => void, reason: string): void {
  try {
    fn();
    throw new Error("expected run budget reservation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddedAgentRunBudgetExceededError);
    expect((error as EmbeddedAgentRunBudgetExceededError).terminalReason).toBe(reason);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddedAgentRunBudgetController", () => {
  it("reserves model/provider dispatches without admitting work over either ceiling", () => {
    const controller = new EmbeddedAgentRunBudgetController({ limits: createLimits() });

    controller.reserveModelInvocation();
    controller.reserveModelInvocation();
    expectBudgetReason(() => controller.reserveModelInvocation(), "model_turns");

    expect(controller.complete()).toMatchObject({
      completed: false,
      terminalReason: "model_turns",
      counters: { modelTurns: 2, providerAttempts: 2 },
    });
    controller.dispose();
  });

  it("uses the provider-attempt ceiling when it is lower than the model-turn ceiling", () => {
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits({ maxModelTurns: 4, maxProviderAttempts: 1 }),
    });

    controller.reserveModelInvocation();
    expectBudgetReason(() => controller.reserveModelInvocation(), "provider_attempts");

    expect(controller.complete()).toMatchObject({
      terminalReason: "provider_attempts",
      counters: { modelTurns: 1, providerAttempts: 1 },
      retryable: true,
    });
    controller.dispose();
  });

  it("stops a repeated-tool loop before the first over-budget tool starts", () => {
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits({ maxToolCalls: 1 }),
    });

    controller.reserveToolCall();
    expectBudgetReason(() => controller.reserveToolCall(), "tool_calls");

    expect(controller.complete()).toMatchObject({
      terminalReason: "tool_calls",
      counters: { toolCalls: 1 },
    });
    controller.dispose();
  });

  it("accumulates output usage and stops before later provider or tool work", () => {
    const controller = new EmbeddedAgentRunBudgetController({ limits: createLimits() });

    expect(controller.recordOutputTokens(4)).toBe(true);
    expect(controller.recordOutputTokens(6)).toBe(false);
    expectBudgetReason(() => controller.reserveToolCall(), "output_tokens");
    expectBudgetReason(() => controller.reserveModelInvocation(), "output_tokens");

    expect(controller.complete()).toMatchObject({
      terminalReason: "output_tokens",
      counters: { outputTokens: 10, toolCalls: 0, modelTurns: 0 },
    });
    controller.dispose();
  });

  it("fails closed when provider output usage is missing", () => {
    const controller = new EmbeddedAgentRunBudgetController({ limits: createLimits() });

    expect(controller.recordOutputTokens(undefined)).toBe(false);

    expect(controller.complete()).toMatchObject({
      terminalReason: "output_tokens",
      counters: { outputTokens: 10 },
    });
    controller.dispose();
  });

  it("fails closed at completion when the event-loop timer has not fired yet", () => {
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits({ maxDurationMs: 1_000 }),
      startedAtMs: Date.now() - 1_000,
    });

    expect(controller.complete()).toMatchObject({
      completed: false,
      terminalReason: "timeout",
    });
    expect(controller.signal.aborted).toBe(true);
    controller.dispose();
  });

  it("links the wall-clock deadline to the root abort signal", async () => {
    vi.useFakeTimers();
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits({ maxDurationMs: 25 }),
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.complete()).toMatchObject({
      completed: false,
      terminalReason: "timeout",
      retryable: true,
    });
    controller.dispose();
  });

  it("links caller cancellation to the same sticky terminal controller", () => {
    const caller = new AbortController();
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits(),
      callerAbortSignal: caller.signal,
    });

    caller.abort();

    expect(controller.signal.aborted).toBe(true);
    expectBudgetReason(() => controller.reserveToolCall(), "canceled");
    expect(controller.complete()).toMatchObject({
      completed: false,
      terminalReason: "canceled",
      retryable: false,
    });
    controller.dispose();
  });

  it("bounds provider output before a terminal tool call can reach the agent loop", async () => {
    const controller = new EmbeddedAgentRunBudgetController({
      limits: createLimits({
        maxModelTurns: 3,
        maxProviderAttempts: 3,
        maxOutputTokens: 10,
      }),
    });
    const model = {
      api: "openai-completions",
      provider: "openai",
      id: "budget-test",
    } as Model;
    const outputs = [6, 4];
    const inner = vi.fn<StreamFn>((requestedModel, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const output = outputs.shift() ?? 0;
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `tool-${output}`,
                name: "appointments_get",
                arguments: {},
              },
            ],
            api: requestedModel.api,
            provider: requestedModel.provider,
            model: requestedModel.id,
            usage: {
              input: 1,
              output,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: output + 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        });
      });
      expect(options?.maxRetries).toBe(0);
      return stream;
    });
    const wrapped = wrapStreamFnWithRunBudget(inner, controller);

    const firstStream = await wrapped(model, { messages: [] });
    expect((await firstStream.result()).stopReason).toBe("toolUse");
    const secondStream = await wrapped(model, { messages: [] });
    const secondMessage = await secondStream.result();

    expect(secondMessage.stopReason).toBe("aborted");
    expect(secondMessage.content).toEqual([]);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[0]?.[2]?.maxTokens).toBe(10);
    expect(inner.mock.calls[1]?.[2]?.maxTokens).toBe(4);
    await expect(wrapped(model, { messages: [] })).rejects.toMatchObject({
      terminalReason: "output_tokens",
    });
    expect(inner).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("preserves a provider stream failure when no budget ceiling fired", async () => {
    const controller = new EmbeddedAgentRunBudgetController({ limits: createLimits() });
    const model = {
      api: "openai-completions",
      provider: "openai",
      id: "budget-test",
    } as Model;
    const inner = vi.fn<StreamFn>(() => {
      return {
        push: vi.fn(),
        end: vi.fn(),
        result: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("transport exploded");
            },
          };
        },
      } as unknown as ReturnType<typeof createAssistantMessageEventStream>;
    });

    const stream = await wrapStreamFnWithRunBudget(inner, controller)(model, { messages: [] });
    const result = await stream.result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "transport exploded",
      content: [],
    });
    expect(controller.isTerminal()).toBe(false);
    controller.dispose();
  });
});
