// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  SET_RUNTIME_API_KEY_FIELD,
  imageRuntimeMocks,
  installImageRuntimeTestHooks,
  preparedAuthStorage,
} from "./image.test-support.js";

const {
  completeMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
} = imageRuntimeMocks;

const { describeImageWithModelCore } = await import("./image.js");

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks();

  it("reports the resolved model input when an image model is text-only", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "lmstudio",
        id: "text-only",
        api: "openai-completions",
        input: ["text"],
        baseUrl: "http://127.0.0.1:1234",
      })),
    });

    await expect(
      describeImageWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "lmstudio",
        model: "text-only",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      "Model does not support images: lmstudio/text-only (resolved lmstudio/text-only input: text)",
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("passes image prompt as system instructions for codex image requests", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    const firstCall = expectDefined(completeMock.mock.calls[0], "image completion call 0");
    const [completionModel, context, options] = firstCall;
    expect(completionModel).toEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );
    expect(context.systemPrompt).toBe("Describe the image.");
    expect(context.messages).toHaveLength(1);
    expect(Object.keys(options).toSorted()).toEqual(["apiKey", "maxTokens", "signal", "timeoutMs"]);
    expect(options.apiKey).toBe("test-token");
    expect(options.maxTokens).toBe(4096);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(1000);
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected image completion user message");
    }
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toHaveLength(1);
    expect(userMessage.content[0]).toEqual({
      type: "image",
      data: Buffer.from("png-bytes").toString("base64"),
      mimeType: "image/png",
    });
  });

  it("clamps oversized image description timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    const firstCall = expectDefined(completeMock.mock.calls[0], "image completion call 0");
    expect(firstCall[2].timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("places OpenRouter image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "openrouter",
        id: "google/gemini-2.5-flash",
        input: ["text", "image"],
        baseUrl: "https://openrouter.ai/api/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "openrouter ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "openrouter ok",
      model: "google/gemini-2.5-flash",
    });
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "OpenRouter image completion call 0",
    );
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected OpenRouter image completion user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe the image." },
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("places DashScope image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "qwen",
        id: "qwen3.6-plus",
        input: ["text", "image"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "qwen",
      model: "qwen3.6-plus",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "dashscope ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "qwen",
      model: "qwen3.6-plus",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "dashscope ok",
      model: "qwen3.6-plus",
    });
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "DashScope image completion call 0",
    );
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected DashScope image completion user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe the image." },
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it.each([
    {
      name: "direct OpenAI Responses baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "default OpenAI Responses route without explicit baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "azure-openai provider using openai-responses api",
      provider: "azure-openai",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "proxy-like openai-responses route",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://proxy.example.com/v1",
      },
      expectedRetryPayload: {},
    },
  ])(
    "retries reasoning-only image responses with reasoning disabled for $name",
    async ({ provider, model, expectedRetryPayload }) => {
      discoverModelsMock.mockReturnValue({
        find: vi.fn(() => model),
      });
      completeMock
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "internal image reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [{ type: "text", text: "retry ok" }],
        });

      const result = await describeImageWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider,
        model: model.id,
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        text: "retry ok",
        model: model.id,
      });
      expect(completeMock).toHaveBeenCalledTimes(2);
      const retryCall = expectDefined(completeMock.mock.calls[1], "retry image completion call 1");
      const [retryModel, , retryOptions] = retryCall;
      if (!retryOptions?.onPayload) {
        throw new Error("expected retry payload mapper");
      }
      const retryPayload = await retryOptions.onPayload(
        {
          reasoning: { effort: "high", summary: "auto" },
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
        },
        retryModel,
      );
      expect(retryPayload).toEqual(expectedRetryPayload);
    },
  );

  it("does not start the reasoning-only retry after caller cancellation", async () => {
    const controller = new AbortController();
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled image description"));
      return {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "thinking", thinking: "internal", thinkingSignature: "reasoning" }],
      };
    });

    await expect(
      describeImageWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "openai",
        model: "gpt-5.4-mini",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled image description");

    expect(completeMock).toHaveBeenCalledOnce();
    const options = expectDefined(
      completeMock.mock.calls[0],
      "cancelled image completion call 0",
    )[2];
    expect(options?.signal?.aborted).toBe(true);
  });

  it("rejects when a generic image completion ignores the abort signal", async () => {
    vi.useFakeTimers();
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow(
      "image description request timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const firstCall = expectDefined(completeMock.mock.calls[0], "timed image completion call 0");
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.signal.aborted).toBe(true);
    expect(options.timeoutMs).toBe(25);
  });

  it("releases the prepared runtime when a provider ignores caller cancellation", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    const assertion = expect(result).rejects.toThrow("caller cancelled provider request");
    controller.abort(new Error("caller cancelled provider request"));
    await assertion;

    expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce();
  });

  it("keeps the full configured timeout for provider requests after slow setup", async () => {
    vi.useFakeTimers();
    const slowSetupMs = 400;
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    resolveModelAsyncMock.mockImplementationOnce(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, slowSetupMs);
        });
        const authStorage = {
          [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
        };
        const modelRegistry = discoverModelsMock(authStorage, agentDir);
        const model = resolveModelWithRegistryMock({
          provider,
          modelId,
          modelRegistry,
          cfg,
          agentDir,
        });
        return { authStorage, model, modelRegistry };
      },
    );
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(slowSetupMs);
    await Promise.resolve();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "slow setup image completion call 0",
    );
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.timeoutMs).toBe(1000);

    const assertion = expect(result).rejects.toThrow(
      `image description request timed out after 1000ms (setup took ${slowSetupMs}ms before provider request started)`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(options.signal.aborted).toBe(true);
  });

  it("rejects when image runtime setup exceeds the request timeout", async () => {
    vi.useFakeTimers();
    resolveModelAsyncMock.mockImplementationOnce(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow(
      "image description setup timed out after 25ms before provider request started",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("releases a prepared generation that resolves after the setup timeout", async () => {
    vi.useFakeTimers();
    let finishResolution!: (value: {
      authStorage: typeof preparedAuthStorage;
      model: { provider: string; id: string; api: string; input: string[] };
      modelRegistry: object;
    }) => void;
    resolveModelAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = resolve;
        }),
    );

    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });
    const assertion = expect(result).rejects.toThrow(
      "image description setup timed out after 25ms before provider request started",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    finishResolution({
      authStorage: preparedAuthStorage,
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
        api: "openai-responses",
        input: ["text", "image"],
      },
      modelRegistry: {},
    });
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce());
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("releases a prepared generation when cancellation wins during setup", async () => {
    let finishResolution!: (value: {
      authStorage: typeof preparedAuthStorage;
      model: { provider: string; id: string; api: string; input: string[] };
      modelRegistry: object;
    }) => void;
    resolveModelAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = resolve;
        }),
    );
    const controller = new AbortController();
    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(resolveModelAsyncMock).toHaveBeenCalledOnce());
    const assertion = expect(result).rejects.toThrow("caller cancelled during setup");
    controller.abort(new Error("caller cancelled during setup"));
    await assertion;
    expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();

    finishResolution({
      authStorage: preparedAuthStorage,
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
        api: "openai-responses",
        input: ["text", "image"],
      },
      modelRegistry: {},
    });

    await vi.waitFor(() => expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce());
    expect(completeMock).not.toHaveBeenCalled();
  });
});
