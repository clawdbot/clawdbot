import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { completeSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

describe("LLM completion transport host", () => {
  it("installs runtime transport ports before a bare simple completion", async () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
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
    const providerStream = (
      runtimeModel: Model,
      context: Context,
    ): AssistantMessageEventStreamContract => {
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
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: "stop", message });
      output.end();
      return output;
    };
    registry.registerApiProvider({
      api: model.api,
      stream: providerStream,
      streamSimple: providerStream,
    });

    await expect(
      completeSimple(bindModelLlmRuntime(model, runtime), { messages: [] }),
    ).resolves.toEqual(message);
  });

  it.each(["expired authority", "aborted caller"] as const)(
    "rejects an isolated completion with %s during transport setup before provider admission",
    async (reason) => {
      const { runHostPreparedIsolatedCompletion } =
        await import("../agents/host-prepared-isolated-completion.js");
      const registry = createApiRegistry();
      const runtime = createLlmRuntime(registry);
      const model = bindModelLlmRuntime(
        {
          api: "test-isolated-host-api",
          provider: "test-isolated-host",
          id: "test-isolated-host-model",
          name: "Test Isolated Host Model",
          baseUrl: "https://example.test",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1024,
          maxTokens: 512,
        } satisfies Model,
        runtime,
      );
      const providerStream = vi.fn((): AssistantMessageEventStreamContract => {
        throw new Error("Unexpected provider admission");
      });
      registry.registerApiProvider({
        api: model.api,
        stream: providerStream,
        streamSimple: providerStream,
      });
      let current = true;
      const controller = new AbortController();
      const run = runHostPreparedIsolatedCompletion({
        authorization: {
          owner: "host",
          model,
          auth: { apiKey: "test", source: "test", mode: "api-key" },
        },
        provider: model.provider,
        modelId: model.id,
        agentId: "main",
        agentDir: "/tmp/isolated-host-agent",
        workspaceDir: "/tmp/isolated-host-workspace",
        config: {},
        systemPrompt: "system",
        prompt: "user",
        timeoutMs: 1_000,
        abortSignal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Completion authority expired");
          }
        },
      });
      if (reason === "expired authority") {
        current = false;
      } else {
        controller.abort(new Error("Completion caller aborted"));
      }

      await expect(run).rejects.toThrow(
        reason === "expired authority"
          ? "Completion authority expired"
          : "Completion caller aborted",
      );
      expect(providerStream).not.toHaveBeenCalled();
    },
  );
});
