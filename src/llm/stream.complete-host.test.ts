import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
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
});
