import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { stream, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

describe("LLM synchronous stream transport host", () => {
  it("defers provider streams until runtime transport ports are installed", async () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
    const model = {
      api: "test-sync-runtime-host-api",
      provider: "test-sync-runtime-host",
      id: "test-sync-runtime-host-model",
      name: "Test Sync Runtime Host Model",
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
      (runtimeModel: Model, context: Context): AssistantMessageEventStreamContract => {
        expect(getAiTransportHost().plugin.wrapSimpleCompletionStream).not.toBe(inertWrapper);
        expect(context.messages).toEqual([]);
        expect(runtimeModel.id).toBe(model.id);
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
    const boundModel = bindModelLlmRuntime(model, runtime);

    const outputs = [
      stream(boundModel, { messages: [] }),
      streamSimple(boundModel, { messages: [] }),
    ];
    expect(providerStream).not.toHaveBeenCalled();

    await expect(Promise.all(outputs.map((output) => output.result()))).resolves.toEqual([
      message,
      message,
    ]);
    expect(providerStream).toHaveBeenCalledTimes(2);
  });
});
