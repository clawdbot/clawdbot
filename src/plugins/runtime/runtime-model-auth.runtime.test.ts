// Runtime model auth tests cover provider auth resolution inside plugin runtime loading.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModelCore: hoisted.getApiKeyForModel,
  resolveApiKeyForProviderCore: hoisted.resolveApiKeyForProvider,
}));

vi.mock("../provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuth,
}));

let getApiKeyForModel: typeof import("./runtime-model-auth.runtime.js").getApiKeyForModel;
let getRuntimeAuthForModelCore: typeof import("./runtime-model-auth.runtime.js").getRuntimeAuthForModelCore;
let resolveProviderRuntimeApiKey: typeof import("./runtime-model-auth.runtime.js").resolveProviderRuntimeApiKey;

const MODEL = {
  id: "github-copilot/gpt-4o",
  provider: "github-copilot",
  api: "openai-responses",
  baseUrl: "https://api.githubcopilot.com",
};

describe("runtime-model-auth.runtime", () => {
  beforeAll(async () => {
    ({ getApiKeyForModel, getRuntimeAuthForModelCore, resolveProviderRuntimeApiKey } =
      await import("./runtime-model-auth.runtime.js"));
  });

  beforeEach(() => {
    hoisted.getApiKeyForModel.mockReset();
    hoisted.resolveApiKeyForProvider.mockReset();
    hoisted.prepareProviderRuntimeAuth.mockReset();
  });

  it("returns provider-prepared runtime auth when the provider transforms credentials", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "github-device-token",
      source: "profile:github-copilot:github",
      mode: "token",
      profileId: "github-copilot:github",
    });
    hoisted.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "copilot-bearer-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: 123,
    });

    await expect(
      getRuntimeAuthForModelCore({
        model: MODEL as never,
      }),
    ).resolves.toEqual({
      apiKey: "copilot-bearer-token",
      source: "profile:github-copilot:github",
      mode: "token",
      profileId: "github-copilot:github",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: 123,
    });
    expect(hoisted.prepareProviderRuntimeAuth).toHaveBeenCalledWith({
      provider: "github-copilot",
      config: undefined,
      workspaceDir: undefined,
      env: process.env,
      context: {
        config: undefined,
        workspaceDir: undefined,
        env: process.env,
        provider: "github-copilot",
        modelId: "github-copilot/gpt-4o",
        model: MODEL,
        apiKey: "github-device-token",
        authMode: "token",
        profileId: "github-copilot:github",
      },
    });
  });

  it("falls back to raw auth when the provider has no runtime auth hook", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "plain-api-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
    hoisted.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

    await expect(
      getRuntimeAuthForModelCore({
        model: {
          ...MODEL,
          id: "openai/gpt-5.4",
          provider: "openai",
        } as never,
      }),
    ).resolves.toEqual({
      apiKey: "plain-api-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
  });

  it("skips provider preparation when raw auth does not expose an apiKey", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      source: "env:AWS_PROFILE",
      mode: "aws-sdk",
    });

    await expect(
      getRuntimeAuthForModelCore({
        model: {
          ...MODEL,
          id: "bedrock/claude-sonnet",
          provider: "bedrock",
        } as never,
      }),
    ).resolves.toEqual({
      source: "env:AWS_PROFILE",
      mode: "aws-sdk",
    });
    expect(hoisted.prepareProviderRuntimeAuth).not.toHaveBeenCalled();
  });

  it("keeps direct model auth exports available for bundled runtime facades", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
    hoisted.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "provider-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });

    await expect(getApiKeyForModel({ model: MODEL as never })).resolves.toEqual({
      apiKey: "model-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
    await expect(resolveProviderRuntimeApiKey({ provider: "openai" })).resolves.toEqual({
      apiKey: "provider-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
  });
});
