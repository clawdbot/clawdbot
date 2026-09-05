import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { completeSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

function createCompletionRuntime(
  onDispatch?: (model: Model, context: Context, options?: SimpleStreamOptions) => void,
) {
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const model = {
    api: "test-runtime-host-api",
    provider: "test-runtime-host",
    id: "test-runtime-host-model",
    name: "Test Runtime Host Model",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 512,
  } satisfies Model;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "configured" }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  } satisfies AssistantMessage;
  const providerStream = vi.fn(
    (
      runtimeModel: Model,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStreamContract => {
      onDispatch?.(runtimeModel, context, options);
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: "stop", message });
      output.end();
      return output;
    },
  );
  registry.registerApiProvider({
    api: model.api,
    stream: providerStream,
    streamSimple: providerStream,
  });
  return { model: bindModelLlmRuntime(model, runtime), message, providerStream };
}

describe("LLM completion transport host", () => {
  it("installs runtime transport ports before a bare simple completion", async () => {
    const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
    const { model, message, providerStream } = createCompletionRuntime((runtimeModel, context) => {
      const wrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
      expect(wrapper).not.toBe(inertWrapper);
      expect(
        wrapper({
          provider: runtimeModel.provider,
          context: {
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            model: runtimeModel,
            streamFn: providerStream,
          },
        }),
      ).toBeUndefined();
      expect(context.messages).toEqual([]);
    });

    await expect(completeSimple(model, { messages: [] })).resolves.toEqual(message);
  });

  it.each(["current", "retired", "aborted"] as const)(
    "checks %s host-prepared authority after deferred transport initialization",
    async (authority) => {
      const { runHostPreparedIsolatedCompletion } =
        await import("../agents/host-prepared-isolated-completion.js");
      const { model, message, providerStream } = createCompletionRuntime(
        (_runtimeModel, context, options) => {
          expect(context.messages).toEqual([
            { role: "user", content: "Title this chat.", timestamp: expect.any(Number) },
          ]);
          expect(options).toMatchObject({ apiKey: "synthetic-completion-key" });
          expect(options).not.toHaveProperty("assertCurrent");
        },
      );
      const controller = new AbortController();
      const authorityError = new Error("Completion owner retired.");
      let current = true;
      const completion = runHostPreparedIsolatedCompletion({
        provider: model.provider,
        modelId: model.id,
        authorization: {
          owner: "host",
          model,
          auth: { mode: "api-key", source: "test", apiKey: "synthetic-completion-key" },
        },
        config: {},
        agentId: "main",
        agentDir: "/test/agent",
        workspaceDir: "/test/workspace",
        systemPrompt: "Return a brief title.",
        prompt: "Title this chat.",
        timeoutMs: 10_000,
        abortSignal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw authorityError;
          }
        },
      });
      // Even a warm transport host yields before it invokes the provider.
      current = authority !== "retired";
      if (authority === "aborted") {
        controller.abort(authorityError);
      }

      if (authority === "current") {
        await expect(completion).resolves.toEqual({ assistant: message });
        expect(providerStream).toHaveBeenCalledOnce();
      } else {
        await expect(completion).rejects.toBe(authorityError);
        expect(providerStream).not.toHaveBeenCalled();
      }
      expect(controller.signal.aborted).toBe(authority === "aborted");
    },
  );
});
