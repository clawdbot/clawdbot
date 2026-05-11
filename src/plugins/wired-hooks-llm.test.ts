import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const hookCtx = {
  agentId: "main",
  sessionId: "session-1",
};

async function expectLlmHookCall(params: {
  hookName: "model_call_started" | "model_call_ended" | "llm_input" | "llm_output";
  event: Record<string, unknown>;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);
  let expectedEvent: Record<string, unknown> = params.event;

  if (params.hookName === "model_call_started") {
    await runner.runModelCallStarted(
      params.event as Parameters<typeof runner.runModelCallStarted>[0],
      hookCtx,
    );
  } else if (params.hookName === "model_call_ended") {
    await runner.runModelCallEnded(
      params.event as Parameters<typeof runner.runModelCallEnded>[0],
      hookCtx,
    );
  } else if (params.hookName === "llm_input") {
    await runner.runLlmInput(
      {
        ...params.event,
        historyMessages: [...((params.event.historyMessages as unknown[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmInput>[0],
      hookCtx,
    );
    expectedEvent = {
      ...params.event,
      historyMessages: [...((params.event.historyMessages as unknown[] | undefined) ?? [])],
    };
  } else {
    await runner.runLlmOutput(
      {
        ...params.event,
        assistantTexts: [...((params.event.assistantTexts as string[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmOutput>[0],
      hookCtx,
    );
    expectedEvent = {
      ...params.event,
      assistantTexts: [...((params.event.assistantTexts as string[] | undefined) ?? [])],
    };
  }

  expect(handler).toHaveBeenCalledWith(expectedEvent, hookCtx);
}

describe("llm hook runner methods", () => {
  it.each([
    {
      name: "runModelCallStarted invokes registered model_call_started hooks",
      hookName: "model_call_started" as const,
      methodName: "runModelCallStarted" as const,
      event: {
        runId: "run-1",
        callId: "call-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        api: "openai-responses",
        transport: "http",
      },
    },
    {
      name: "runModelCallEnded invokes registered model_call_ended hooks",
      hookName: "model_call_ended" as const,
      methodName: "runModelCallEnded" as const,
      event: {
        runId: "run-1",
        callId: "call-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        durationMs: 42,
        outcome: "error",
        errorCategory: "TimeoutError",
        upstreamRequestIdHash: "sha256:abcdef123456",
      },
    },
    {
      name: "runLlmInput invokes registered llm_input hooks",
      hookName: "llm_input" as const,
      methodName: "runLlmInput" as const,
      event: {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: "be helpful",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
    },
    {
      name: "runLlmOutput invokes registered llm_output hooks",
      hookName: "llm_output" as const,
      methodName: "runLlmOutput" as const,
      event: {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["hi"],
        lastAssistant: { role: "assistant", content: "hi" },
        usage: {
          input: 10,
          output: 20,
          total: 30,
        },
      },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectLlmHookCall({ hookName, event });
  });

  it("hasHooks returns true for registered llm hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_call_started", handler: vi.fn() },
      { hookName: "llm_input", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("model_call_started")).toBe(true);
    expect(runner.hasHooks("model_call_ended")).toBe(false);
    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });
});
