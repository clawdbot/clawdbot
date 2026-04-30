import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  prepareModelForSimpleCompletionMock: vi.fn((params: { model: unknown }) => params.model),
  completeMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: hoisted.completeMock,
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: hoisted.prepareModelForSimpleCompletionMock,
}));

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("./github-copilot-token.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

let completeWithPreparedSimpleCompletionModel: typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;
let prepareSimpleCompletionModel: typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModel;

beforeAll(async () => {
  ({ completeWithPreparedSimpleCompletionModel, prepareSimpleCompletionModel } =
    await import("./simple-completion-runtime.js"));
});

beforeEach(() => {
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.prepareModelForSimpleCompletionMock.mockReset();
  hoisted.completeMock.mockReset();

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);
  hoisted.prepareModelForSimpleCompletionMock.mockImplementation(
    (params: { model: unknown }) => params.model,
  );
  hoisted.completeMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.resolveModelAsyncMock.mockImplementation((...args: unknown[]) =>
    Promise.resolve(hoisted.resolveModelMock(...args)),
  );
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot-runtime-token",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
});

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "anthropic",
          id: "claude-opus-4-6",
        }),
        auth: expect.objectContaining({
          mode: "api-key",
          source: "env:TEST_API_KEY",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "amazon-bedrock",
          id: "anthropic.claude-sonnet-4-6",
        }),
        auth: {
          source: "aws-sdk default chain",
          mode: "aws-sdk",
        },
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "github-copilot",
      "copilot-runtime-token",
    );
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // The returned auth.apiKey should be the exchanged runtime token,
    // not the original GitHub token
    expect(result.auth.apiKey).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot-runtime-token",
      expiresAt: Date.now() + 60_000,
      source: "cache:/tmp/copilot-token.json",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model).toEqual(
      expect.objectContaining({
        baseUrl: "https://api.copilot.enterprise.example",
      }),
    );
  });

  it("returns error when getApiKeyForModel throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "local-openai",
      modelId: "chat-local",
    });

    expect(hoisted.applyLocalNoAuthHeaderOverrideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-openai",
        id: "chat-local",
      }),
      expect.objectContaining({
        apiKey: "custom-local",
        source: "models.providers.local-openai (synthetic local key)",
        mode: "api-key",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: null }),
        }),
      }),
    );
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    expect(hoisted.prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock-mantle",
        workspaceDir: "/tmp/openclaw-agent",
        context: expect.objectContaining({
          apiKey: "__amazon_bedrock_mantle_iam__",
          authMode: "api-key",
          modelId: "anthropic.claude-opus-4-7",
          profileId: "mantle",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "amazon-bedrock-mantle",
      "bedrock-runtime-token",
    );
    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
        }),
        auth: expect.objectContaining({
          apiKey: "bedrock-runtime-token",
        }),
      }),
    );
  });

  it("can skip Pi model/auth discovery for config-scoped one-shot completions", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "ollama",
        id: "llama3.2:latest",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "ollama",
      modelId: "llama3.2:latest",
      skipPiDiscovery: true,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "ollama",
      "llama3.2:latest",
      undefined,
      undefined,
      {
        skipPiDiscovery: true,
      },
    );
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"ollama">;
    const preparedModel = {
      ...model,
      api: "openclaw-ollama-simple-test",
    };
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };
    hoisted.prepareModelForSimpleCompletionMock.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "ollama-local",
        source: "models.json (local marker)",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
    });

    expect(hoisted.prepareModelForSimpleCompletionMock).toHaveBeenCalledWith({ model, cfg });
    expect(hoisted.completeMock).toHaveBeenCalledWith(
      preparedModel,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        apiKey: "ollama-local",
      },
    );
  });
});
