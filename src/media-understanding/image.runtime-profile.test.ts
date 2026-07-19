// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";

const API_KEY_FIELD = ["api", "Key"].join("") as "apiKey";
const REQUIRE_API_KEY_FIELD = ["require", "ApiKey"].join("");
const SET_RUNTIME_API_KEY_FIELD = ["setRuntime", "ApiKey"].join("");

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn(
    async (): Promise<{
      apiKey: string;
      source: string;
      mode: string;
      profileId?: string;
    }> => ({
      [API_KEY_FIELD]: "test-token",
      source: "test",
      mode: "oauth",
    }),
  ),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    [API_KEY_FIELD]: "test-token",
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  fetchMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
  prepareProviderDynamicModelMock: vi.fn(async () => {}),
  prepareProviderRuntimeAuthMock: vi.fn(),
  acquireAgentRunPreparedModelRuntimeMock: vi.fn(),
  releasePreparedModelRuntimeMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  shouldPreferProviderRuntimeResolvedModelMock: vi.fn(() => false),
  unwrapSecretSentinelsForProviderEgressMock: vi.fn((value: string) => value),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  registerProviderStreamForModelMock,
  prepareProviderDynamicModelMock,
  prepareProviderRuntimeAuthMock,
  acquireAgentRunPreparedModelRuntimeMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = hoisted;
const preparedAuthStorage = { [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock };

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

type AuthRequestCall = {
  profileId?: string;
  preferredProfile?: string;
  store?: unknown;
};

function requireMockCallAt<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  index: number,
  label: string,
): Calls[number] {
  // Tests inspect exact dependency calls because image runtime behavior is
  // mostly provider/auth orchestration.
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label} call ${index}`);
  }
  return call as Calls[number];
}

function requireFirstMockCall<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  label: string,
): Calls[number] {
  return requireMockCallAt(mock, 0, label);
}

vi.mock("../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  getApiKeyForModel: getApiKeyForModelMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  [REQUIRE_API_KEY_FIELD]: requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

vi.mock("../agents/sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: () => ({ apiRegistry: {}, llmRuntime: {} }),
}));

vi.mock("../agents/provider-secret-egress.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/provider-secret-egress.js")>(
    "../agents/provider-secret-egress.js",
  )),
  unwrapSecretSentinelsForProviderEgress: unwrapSecretSentinelsForProviderEgressMock,
}));

vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({
    [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: acquireAgentRunPreparedModelRuntimeMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  prepareProviderDynamicModel: prepareProviderDynamicModelMock,
  shouldPreferProviderRuntimeResolvedModel: shouldPreferProviderRuntimeResolvedModelMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: prepareProviderRuntimeAuthMock,
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync: resolveModelAsyncMock,
}));

vi.mock("../plugin-sdk/provider-auth.js", () => ({
  buildCopilotIdeHeaders: () => ({
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  }),
  COPILOT_INTEGRATION_ID: "vscode-chat",
}));

const imageTestFetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...mod,
    fetchWithSsrFGuard: imageTestFetchWithSsrFGuardMock,
  };
});

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Provider endpoint policy comes from manifests. Pin source manifests so a
    // prior local build cannot make this source-checkout test read partial dist output.
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    acquireAgentRunPreparedModelRuntimeMock.mockImplementation(
      async (input: { agentDir: string; config: object; workspaceDir?: string }) => ({
        snapshot: {
          agentDir: input.agentDir,
          config: input.config,
          workspaceDir: input.workspaceDir,
          createStores: () => ({
            authStorage: preparedAuthStorage,
            modelRegistry: {},
          }),
        },
        release: releasePreparedModelRuntimeMock,
      }),
    );
    fetchMock.mockImplementation(async () =>
      Response.json({
        base_resp: { status_code: 0 },
        content: "portal ok",
      }),
    );
    // Bridge fetchWithSsrFGuard through the globally-stubbed fetch so existing
    // assertions on fetchMock call count and arguments continue to work.
    imageTestFetchWithSsrFGuardMock.mockImplementation(
      async (opts: { url: string; init: RequestInit; timeoutMs?: number }) => {
        const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
        const init = { ...opts.init, signal };
        const response = await globalThis.fetch(opts.url, init);
        return { response, release: vi.fn(), finalUrl: opts.url };
      },
    );
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    resolveModelWithRegistryMock.mockImplementation(
      // Delegate to modelRegistry.find so tests that override discoverModelsMock
      // automatically get the right model through resolveModelWithRegistry.
      ({ modelRegistry, provider, modelId }: ResolveModelWithRegistryTestParams) =>
        modelRegistry.find(provider, modelId),
    );
    resolveModelAsyncMock.mockImplementation(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
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
    prepareProviderRuntimeAuthMock.mockImplementation(async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            [API_KEY_FIELD]: "test-token",
            baseUrl: "https://api.githubcopilot.com",
          }
        : undefined;
    });
  });

  function getApiKeyForModelCall(index = 0): AuthRequestCall {
    const call = (getApiKeyForModelMock.mock.calls as unknown[][]).at(index);
    if (!call) {
      throw new Error(`Expected getApiKeyForModel call ${index}`);
    }
    return call[0] as AuthRequestCall;
  }

  it("normalizes deprecated google flash ids and keeps profile model/auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        provider: "google",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      preferredProfile: "google:preferred",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(findMock).toHaveBeenCalled();
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toEqual(
        expect.objectContaining({
          authProfileId: "google:default",
          preferredProfile: "google:preferred",
        }),
      );
    }
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(authRequest?.preferredProfile).toBe("google:preferred");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
  });

  it("keeps stable GA gemini 3.1 flash-lite ids during lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite");
      return {
        provider: "google",
        id: "gemini-3.1-flash-lite",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash lite ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite",
    });
    expect(findMock).toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
  });

  it("rematerializes profile-scoped image metadata after auth selects a backup profile", async () => {
    const authStorage = { [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock };
    const modelRegistry = {};
    const hintedModel = {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const authoritativeModel = {
      ...hintedModel,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
    resolveModelAsyncMock
      .mockResolvedValueOnce({ model: hintedModel, authStorage, modelRegistry })
      .mockResolvedValueOnce({ model: hintedModel, authStorage, modelRegistry })
      .mockResolvedValueOnce({ model: authoritativeModel, authStorage, modelRegistry });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "test-token",
      source: "profile:github-copilot:backup",
      mode: "token",
      profileId: "github-copilot:backup",
    });
    shouldPreferProviderRuntimeResolvedModelMock.mockReturnValueOnce(true);
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "profile-scoped image ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      profile: "github-copilot:preferred",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(3);
    expect(resolveModelAsyncMock.mock.calls[2]?.[4]).toEqual(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "github-copilot:backup",
      }),
    );
    const [completionModel] = requireFirstMockCall(completeMock, "complete");
    expect(completionModel).toEqual(
      expect.objectContaining({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }),
    );
  });

  it("places image prompt in user content for github-copilot provider", async () => {
    const providerStreamResult = {
      role: "assistant",
      api: "openai-completions",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    };
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () => providerStreamResult),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://stale.example.test",
      })),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledOnce();
    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ [API_KEY_FIELD]: "test-token", authMode: "oauth" }),
      }),
    );
    const storedValue = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(setRuntimeApiKeyMock.mock.calls[0]?.[0]).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedValue)).toBe(true);
    expect(storedValue).not.toBe("test-token");
    expect(resolveSecretSentinel(storedValue)).toBe("test-token");
    const [completionModel, context, options] = providerStreamFn.mock.calls[0] as unknown as [
      { baseUrl?: string },
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
      { apiKey?: string; headers?: Record<string, string> },
    ];
    expect(completionModel.baseUrl).toBe("https://api.githubcopilot.com");
    expect(options.apiKey).toBe(storedValue);
    expect(options.headers).toMatchObject({
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Version": "vscode/1.107.0",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    });
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("keeps an exchanged Copilot image token opaque for sentinel-backed auth", async () => {
    const sourceValue = "test-token";
    const preparedValue = mintSecretSentinel(sourceValue, {
      label: "model-auth:github-copilot",
    });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: preparedValue,
      source: "test",
      mode: "token",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce(sourceValue);
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () => ({
        role: "assistant",
        api: "openai-completions",
        provider: "github-copilot",
        model: "gpt-4.1",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
      })),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gpt-4.1",
        input: ["text", "image"],
        api: "openai-completions",
      })),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gpt-4.1",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ [API_KEY_FIELD]: preparedValue, authMode: "token" }),
      }),
    );
    const storedValue = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(looksLikeSecretSentinel(storedValue)).toBe(true);
    expect(resolveSecretSentinel(storedValue)).toBe("test-token");
    const streamOptions = providerStreamFn.mock.calls[0]?.[2] as { apiKey?: string };
    expect(streamOptions.apiKey).toBe(storedValue);
  });

  it("fails github-copilot image runtime setup when token exchange fails", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com",
      })),
    });
    prepareProviderRuntimeAuthMock.mockRejectedValueOnce(
      new Error("Copilot token exchange failed: HTTP 401"),
    );

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "github-copilot",
        model: "gemini-3.1-pro-preview",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(setRuntimeApiKeyMock).not.toHaveBeenCalledWith("github-copilot", "test-token");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not place image prompt in user content for non-copilot providers", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-4o",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-4o",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).toHaveBeenCalledOnce();
    const [, context] = completeMock.mock.calls[0] as [
      unknown,
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
    ];
    // Non-Copilot providers keep prompt in system message, images in user message
    expect(context.systemPrompt).toBe("Describe the image.");
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).not.toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("defaults image-describe maxTokens to 4096 for reasoning-capable VLMs", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "agent-plan",
        id: "doubao-seed-2.0-pro",
        input: ["text", "image"],
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "agent-plan",
      model: "doubao-seed-2.0-pro",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "agent-plan",
      model: "doubao-seed-2.0-pro",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    const options = requireFirstMockCall(completeMock, "image completion")[2];
    expect(options.maxTokens).toBe(4096);
  });

  it("caps image-describe maxTokens by the resolved model's own maxTokens", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "fake",
        id: "small-vlm",
        input: ["text", "image"],
        baseUrl: "https://example.test",
        maxTokens: 1024,
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "fake",
      model: "small-vlm",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "fake",
      model: "small-vlm",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    const options = requireFirstMockCall(completeMock, "image completion")[2];
    expect(options.maxTokens).toBe(1024);
  });

  it("derives workspaceDir from agentId for image runtime resolution", async () => {
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
    const cfg = {
      agents: {
        list: [
          {
            id: "vision-agent",
            agentDir: "/tmp/openclaw-agent",
            workspace: "/tmp/openclaw-workspace",
          },
        ],
      },
    };

    await describeImageWithModel({
      cfg,
      agentId: "vision-agent",
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-workspace" }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      cfg,
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-workspace" }),
    );
  });

  it("uses one committed prepared generation for image setup and streaming", async () => {
    const requestedCfg: OpenClawConfig = { logging: { level: "info" } };
    const committedCfg: OpenClawConfig = { logging: { level: "debug" } };
    acquireAgentRunPreparedModelRuntimeMock.mockResolvedValueOnce({
      snapshot: {
        agentDir: "/tmp/committed-agent",
        config: committedCfg,
        workspaceDir: "/tmp/committed-workspace",
        createStores: () => ({
          authStorage: preparedAuthStorage,
          modelRegistry: {},
        }),
      },
      release: releasePreparedModelRuntimeMock,
    });
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
      content: [{ type: "text", text: "committed runtime" }],
    });

    await describeImageWithModel({
      cfg: requestedCfg,
      agentDir: "/tmp/requested-agent",
      workspaceDir: "/tmp/requested-workspace",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/committed-agent",
      committedCfg,
      expect.objectContaining({ workspaceDir: "/tmp/committed-workspace" }),
    );
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: expect.objectContaining({ id: "gemini-2.5-flash" }),
      cfg: committedCfg,
      agentDir: "/tmp/committed-agent",
      workspaceDir: "/tmp/committed-workspace",
    });
  });

  it("reuses a parent run generation without acquiring another image lease", async () => {
    const cfg: OpenClawConfig = { logging: { level: "info" } };
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
      content: [{ type: "text", text: "parent runtime" }],
    });
    const preparedModelRuntime = {
      agentDir: "/tmp/parent-agent",
      config: cfg,
      workspaceDir: "/tmp/parent-workspace",
      createStores: () => ({ authStorage: preparedAuthStorage, modelRegistry: {} }),
    } as never;

    const result = await describeImageWithModel({
      cfg,
      agentDir: "/tmp/parent-agent",
      workspaceDir: "/tmp/parent-workspace",
      preparedModelRuntime,
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result.text).toBe("parent runtime");
    expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
    expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
  });
});
