import { expectDefined } from "@openclaw/normalization-core/expect";
// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  API_KEY_FIELD,
  SET_RUNTIME_API_KEY_FIELD,
  imageRuntimeMocks,
  imageTestFetchWithSsrFGuardMock,
  installImageRuntimeTestHooks,
  preparedAuthStorage,
  type ResolveModelWithRegistryTestParams,
} from "./image.test-support.js";

const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderCoreMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  registerProviderStreamForModelMock,
  prepareProviderDynamicModelMock,
  acquireAgentRunPreparedModelRuntimeMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = imageRuntimeMocks;

const requireRecord = createRequireRecord("record", "expected-label-capitalized");
type AuthRequestCall = {
  profileId?: string;
  preferredProfile?: string;
  store?: unknown;
};

const { describeImageWithModelCore, describeImagesWithModelCore } = await import("./image.js");

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  function getApiKeyForModelCall(index = 0): AuthRequestCall {
    const call = (getApiKeyForModelMock.mock.calls as unknown[][]).at(index);
    if (!call) {
      throw new Error(`Expected getApiKeyForModelCore call ${index}`);
    }
    return call[0] as AuthRequestCall;
  }

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const authStore = { version: 1, profiles: {} };
    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      authStore,
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.store).toBe(authStore);
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "test-api-key");
    const [fetchUrl, fetchOptionsValue] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(fetchUrl).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(fetchOptions).toEqual({
      method: "POST",
      headers: fetchOptions.headers,
      body: JSON.stringify({
        prompt: "Describe the image.",
        image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      }),
      signal: fetchOptions.signal,
    });
    expect(Object.fromEntries(new Headers(fetchOptions.headers as HeadersInit))).toEqual({
      authorization: ["Bearer", "test-api-key"].join(" "),
      "content-type": "application/json",
      "mm-api-source": "OpenClaw",
    });
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not start another MiniMax request after caller cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled MiniMax image batch"));
      return Response.json({
        base_resp: { status_code: 0 },
        content: "first image",
      });
    });

    await expect(
      describeImagesWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        images: [
          { buffer: Buffer.from("first"), fileName: "first.png", mime: "image/png" },
          { buffer: Buffer.from("second"), fileName: "second.png", mime: "image/png" },
        ],
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled MiniMax image batch");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("carries resolved MiniMax model transport policy into the VLM request", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() =>
        attachModelProviderRequestTransport(
          {
            provider: "minimax-portal",
            id: "MiniMax-VL-01",
            input: ["text", "image"],
            baseUrl: "https://custom-minimax.example.com/anthropic",
          },
          {
            proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" },
          },
        ),
      ),
    });

    await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    const guardedOptions = requireRecord(
      expectDefined(imageTestFetchWithSsrFGuardMock.mock.calls[0], "guarded fetch call 0")[0],
      "guarded fetch options",
    );
    expect(guardedOptions.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example.com",
    });
  });

  it("unwraps a sentinel only at the direct MiniMax VLM handoff", async () => {
    const sentinelValue = mintSecretSentinel("test-api-key", { label: "test:minimax" });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: sentinelValue,
      source: "test",
      mode: "api-key",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce("test-token");

    await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    expect(unwrapSecretSentinelsForProviderEgressMock).toHaveBeenCalledWith(
      sentinelValue,
      "MiniMax VLM request",
    );
    const [, fetchOptionsValue] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(new Headers(fetchOptions.headers as HeadersInit).get("Authorization")).toBe(
      ["Bearer", "test-token"].join(" "),
    );
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-portal",
      model: "custom-vision",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "generic ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "custom-vision",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "generic ok",
      model: "custom-vision",
    });
    const [streamRequest] = expectDefined(
      registerProviderStreamForModelMock.mock.calls[0],
      "provider stream registration call 0",
    );
    expect(streamRequest).toEqual({
      model: expect.objectContaining({
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      }),
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      wrapProviderStream: true,
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("describes images keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "",
      source: "profile:amazon-bedrock:default",
      mode: "aws-sdk",
    });
    // Faithful to runtime: requireApiKey throws on an empty resolved key. The
    // aws-sdk carve-out must return before reaching it.
    requireApiKeyMock.mockImplementation((auth: { apiKey?: string; mode?: string }) => {
      const key = auth.apiKey?.trim();
      if (!key) {
        throw new Error(
          `No API key resolved for provider "amazon-bedrock" (auth mode: ${auth.mode}).`,
        );
      }
      return key;
    });
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-sonnet-4-6-v1",
        input: ["text", "image"],
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6-v1",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "an orange tabby cat" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6-v1",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "an orange tabby cat",
      model: "us.anthropic.claude-sonnet-4-6-v1",
    });
    // The carve-out returns before requireApiKey and skips persisting an
    // empty-string secret; the empty key flows through to the model runtime.
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
    const completeCall = expectDefined(completeMock.mock.calls[0], "complete call 0");
    expect(requireRecord(completeCall[2], "stream options").apiKey).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes workspaceDir through MiniMax VLM fallback auth", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-portal/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-portal",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses canonical MiniMax CN baseUrl for VLM alias fallback", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        cfg: {
          models: {
            providers: {
              minimax: {
                [API_KEY_FIELD]: "test-api-key",
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax",
      }),
    );
    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("uses MiniMax CN alias auth when the alias apiKey is a SecretRef", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        cfg: {
          models: {
            providers: {
              "minimax-cn": {
                [API_KEY_FIELD]: {
                  source: "file",
                  provider: "default",
                  id: "/providers/minimax-cn/apiKey",
                },
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-cn",
      }),
    );
    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("does not inherit global MiniMax baseUrl for CN VLM aliases", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        cfg: {
          models: {
            providers: {
              minimax: { baseUrl: "https://api.minimax.io/anthropic", models: [] },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("carries workspaceDir through image model and stream resolution", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "workspace ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentId: "vision-agent",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result.text).toBe("workspace ok");
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "vision-agent",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
      { catalogMode: "static" },
    );
    expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce();
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: preparedAuthStorage,
        modelRegistry: {},
        preparedModelRuntime: expect.objectContaining({
          agentDir: "/tmp/openclaw-agent",
          workspaceDir: "/tmp/openclaw-workspace",
        }),
        skipAgentDiscovery: true,
        workspaceDir: "/tmp/openclaw-workspace",
      },
    );
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: expect.objectContaining({
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      }),
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      wrapProviderStream: true,
    });
  });

  it("normalizes the image model once before provider dispatch", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockImplementation(
      async (_provider, _modelId, _agentDir, _cfg, options) => ({
        authStorage,
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: options?.skipProviderRuntimeHooks ? "openai-completions" : "openai-responses",
          input: ["text", "image"],
        },
      }),
    );
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "normalized ok" }],
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
      text: "normalized ok",
      model: "gpt-5.4",
    });
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelAsyncMock).toHaveBeenCalledExactlyOnceWith(
      "openai",
      "gpt-5.4",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: preparedAuthStorage,
        modelRegistry: {},
        preparedModelRuntime: expect.objectContaining({ agentDir: "/tmp/openclaw-agent" }),
        skipAgentDiscovery: true,
      },
    );
    const [completeModel] = expectDefined(completeMock.mock.calls[0], "complete call 0");
    expect(requireRecord(completeModel, "complete model").api).toBe("openai-responses");
  });

  it("uses plugin stream hooks when available for image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      })),
    });
    const streamResult = {
      result: vi.fn(async () => ({
        role: "assistant",
        api: "ollama",
        provider: "ollama",
        model: "llava:latest",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: "plugin vision ok" }],
      })),
    };
    const streamFn = vi.fn(() => streamResult);
    registerProviderStreamForModelMock.mockReturnValueOnce(streamFn);

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "ollama",
      model: "llava:latest",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "plugin vision ok",
      model: "llava:latest",
    });
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: expect.objectContaining({
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      }),
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      wrapProviderStream: true,
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("resolves configured image models when discovery has not registered the provider", async () => {
    const registryFind = vi.fn(() => null);
    discoverModelsMock.mockReturnValue({ find: registryFind });
    resolveModelWithRegistryMock.mockImplementation(
      ({ provider, modelId }: ResolveModelWithRegistryTestParams) => ({
        provider,
        id: modelId,
        api: "anthropic-messages",
        input: ["text", "image"],
        baseUrl: "http://127.0.0.1:1234",
      }),
    );
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "local vision ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {
        models: {
          providers: {
            lmstudio: {
              api: "anthropic-messages",
              baseUrl: "http://127.0.0.1:1234",
              models: [
                {
                  id: "google/gemma-4-e2b",
                  name: "google/gemma-4-e2b",
                  input: ["text", "image"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131_072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "local vision ok",
      model: "google/gemma-4-e2b",
    });
    expect(registryFind).not.toHaveBeenCalled();
    const [resolveRequestValue] = expectDefined(
      resolveModelWithRegistryMock.mock.calls[0],
      "model registry resolution call 0",
    );
    const resolveRequest = requireRecord(resolveRequestValue, "model registry request");
    expect(resolveRequest.provider).toBe("lmstudio");
    expect(resolveRequest.modelId).toBe("google/gemma-4-e2b");
    expect(resolveRequest.agentDir).toBe("/tmp/openclaw-agent");
    expect(
      requireRecord(
        requireRecord(
          requireRecord(requireRecord(resolveRequest.cfg, "request config").models, "models")
            .providers,
          "model providers",
        ).lmstudio,
        "lmstudio provider",
      ).baseUrl,
    ).toBe("http://127.0.0.1:1234");
    expect(prepareProviderDynamicModelMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledOnce();
  });
});
