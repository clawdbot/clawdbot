import { createApiRegistry, type ApiRegistry } from "@openclaw/ai";
import { resetApiProviders } from "@openclaw/ai/providers";
import { withRunFailureOrigin } from "@openclaw/llm-core/diagnostics";
// Covers dynamic registration of custom model API providers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";

let registry: ApiRegistry;

function getRegisteredTestProvider() {
  const provider = registry.getApiProvider("test-custom-api");
  if (!provider) {
    throw new Error("expected test-custom-api provider to be registered");
  }
  return provider;
}

describe("ensureCustomApiRegistered", () => {
  beforeEach(() => {
    registry = createApiRegistry();
  });

  it("registers a custom api provider once", () => {
    // Custom API registration is idempotent so repeated plugin setup does not
    // replace provider entries or create duplicate sources.
    const streamFn = vi.fn(() => createAssistantMessageEventStream());

    expect(ensureCustomApiRegistered(registry, "test-custom-api", streamFn)).toBe(true);
    expect(ensureCustomApiRegistered(registry, "test-custom-api", streamFn)).toBe(false);

    const provider = getRegisteredTestProvider();
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.streamSimple).toBe("function");
  });

  it("delegates both stream entrypoints to the provided stream function", () => {
    const stream = createAssistantMessageEventStream();
    const streamFn = vi.fn(() => stream);
    ensureCustomApiRegistered(registry, "test-custom-api", streamFn);

    const provider = getRegisteredTestProvider();

    const model = { api: "test-custom-api", provider: "custom", id: "m" };
    const context = { messages: [] };
    const options = { maxTokens: 32 };

    expect(provider.stream(model as never, context as never, options as never)).toBe(stream);
    expect(provider.streamSimple(model as never, context as never, options as never)).toBe(stream);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("adapts async stream factories to the synchronous provider contract", async () => {
    const message = buildAssistantMessage({
      model: { api: "test-custom-api", provider: "custom", id: "m" },
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    const streamFn = vi.fn(async () => {
      await Promise.resolve();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    });
    ensureCustomApiRegistered(registry, "test-custom-api", streamFn);

    const provider = getRegisteredTestProvider();
    const stream = provider.stream(
      { api: "test-custom-api", provider: "custom", id: "m" } as never,
      { messages: [] },
      {},
    );

    expect(stream).not.toBeInstanceOf(Promise);
    await expect(stream.result()).resolves.toBe(message);
  });

  it.each(["provider", "runtime", "runtime-abort"] as const)(
    "converts async stream factory failures with %s origin into terminal errors",
    async (origin) => {
      const controller = new AbortController();
      const streamFn = vi.fn(async () => {
        const failure = new Error("factory failed");
        if (origin === "runtime-abort") {
          controller.abort(withRunFailureOrigin(failure, "runtime"));
          throw new Error("factory failed");
        }
        throw origin === "runtime" ? withRunFailureOrigin(failure, "runtime") : failure;
      });
      ensureCustomApiRegistered(registry, "test-custom-api", streamFn);

      const provider = getRegisteredTestProvider();
      const stream = provider.stream(
        { api: "test-custom-api", provider: "custom", id: "m" } as never,
        { messages: [] },
        { signal: controller.signal },
      );

      const result = await stream.result();
      expect(result).toMatchObject({ stopReason: "error", errorMessage: "factory failed" });
      expect(
        result.diagnostics?.some((entry) => entry.type === "synthesized_run_failure") ?? false,
      ).toBe(origin !== "provider");
    },
  );

  it("keeps plugin api providers when refreshing built-ins", () => {
    // Built-in refresh should preserve plugin-owned API providers while
    // repopulating core providers.
    const sourceId = "plugin:test-reset-api";
    const api = "test-reset-plugin-api";
    const streamFn = vi.fn(() => createAssistantMessageEventStream());
    const streamSimpleFn = vi.fn(() => createAssistantMessageEventStream());
    registry.registerApiProvider(
      {
        api,
        stream: streamFn,
        streamSimple: streamSimpleFn,
      },
      sourceId,
    );

    resetApiProviders(registry);

    expect(registry.getApiProvider(api)).toBeDefined();
    expect(registry.getApiProvider("openai-responses")).toBeDefined();

    registry.unregisterApiProviders(sourceId);
  });
});
