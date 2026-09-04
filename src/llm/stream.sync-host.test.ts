import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
} from "@openclaw/llm-core";
import { getRunFailureOrigin, withRunFailureOrigin } from "@openclaw/llm-core/diagnostics";
import { describe, expect, it, vi } from "vitest";
import { transportAbortError } from "../../packages/ai/src/transports/transport-stream-shared.js";
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
    const controller = new AbortController();
    providerStream.mockImplementationOnce(() => {
      controller.abort(withRunFailureOrigin(new Error("runtime stopped"), "runtime"));
      throw transportAbortError(controller.signal);
    });
    const failed = await stream(
      boundModel,
      { messages: [] },
      { signal: controller.signal },
    ).result();
    expect(failed.diagnostics).toEqual([
      { type: "synthesized_run_failure", timestamp: failed.timestamp },
    ]);
  });
});

it("marks deferred host initialization failures before provider dispatch", async () => {
  vi.resetModules();
  vi.doMock("../agents/ai-transport-runtime-host.js", () => ({
    configureAiTransportRuntimeHost: () => {
      throw new Error("401 host setup failed");
    },
  }));
  try {
    const { stream: deferredStream, complete } = await import("./stream.js");
    const model = {
      id: "fixture",
      name: "Fixture",
      provider: "fixture",
      api: "fixture",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 64,
    } satisfies Model;
    const result = await deferredStream(model, { messages: [] }).result();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "401 host setup failed",
      diagnostics: [{ type: "synthesized_run_failure", timestamp: expect.any(Number) }],
    });
    await expect(
      complete(model, { messages: [] }).catch((error: unknown) => getRunFailureOrigin(error)),
    ).resolves.toBe("runtime");
  } finally {
    vi.doUnmock("../agents/ai-transport-runtime-host.js");
  }
});
