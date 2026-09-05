import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import { registerProviderStreamForModel } from "./provider-stream.js";

const { prepare, providerStream, reconcile, runtimeHandle } = vi.hoisted(() => {
  const prepareMock = vi.fn(async () => undefined);
  const reconcileMock = vi.fn(async () => undefined);
  return {
    prepare: prepareMock,
    providerStream: vi.fn(),
    reconcile: reconcileMock,
    runtimeHandle: {
      provider: "test-provider",
      modelId: "test-model",
      plugin: {
        reconcileLocalService: reconcileMock,
        wrapStreamFn: ({ streamFn }: { streamFn: typeof providerStream }) => {
          return async (...args: Parameters<typeof providerStream>) => {
            await prepareMock();
            return streamFn(...args);
          };
        },
      },
    },
  };
});

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: () => providerStream,
}));

vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderRuntimePluginHandle: () => runtimeHandle,
  };
});

describe("provider stream lifecycle registration", () => {
  it("registers provider streams with the resolved runtime lifecycle handle", async () => {
    providerStream.mockReturnValue(createAssistantMessageEventStream());
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = bindModelLlmRuntime(
      {
        api: "test-lifecycle-provider",
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 512,
      },
      llmRuntime,
    );

    const streamFn = registerProviderStreamForModel({ model, wrapProviderStream: true });
    expect(streamFn).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("test-lifecycle-provider")).toBeDefined();
    await streamFn?.(model, {} as never, {});
    expect(getModelProviderLocalServiceReconciler(providerStream.mock.calls[0]![0])).toBe(
      reconcile,
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      providerStream.mock.invocationCallOrder[0]!,
    );
  });
});
