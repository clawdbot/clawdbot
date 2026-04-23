import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: hoisted.getApiKeyForModel,
  resolveApiKeyForProvider: hoisted.resolveApiKeyForProvider,
}));

vi.mock("../provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuth,
}));

let getApiKeyForModel: typeof import("./runtime-model-auth.runtime.js").getApiKeyForModel;
let getRuntimeAuthForModel: typeof import("./runtime-model-auth.runtime.js").getRuntimeAuthForModel;
let resolveApiKeyForProvider: typeof import("./runtime-model-auth.runtime.js").resolveApiKeyForProvider;

const MODEL = {
  id: "github-copilot/gpt-4o",
  provider: "github-copilot",
  api: "openai-responses",
  baseUrl: "https://api.githubcopilot.com",
};

describe("runtime-model-auth.runtime", () => {
  beforeAll(async () => {
    ({ getApiKeyForModel, getRuntimeAuthForModel, resolveApiKeyForProvider } =
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
      getRuntimeAuthForModel({
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
    expect(hoisted.prepareProviderRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({
          apiKey: "github-device-token",
          modelId: "github-copilot/gpt-4o",
          provider: "github-copilot",
        }),
      }),
    );
  });

  it("falls back to raw auth when the provider has no runtime auth hook", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "plain-api-key",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });
    hoisted.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

    await expect(
      getRuntimeAuthForModel({
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
      getRuntimeAuthForModel({
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

    await expect(getApiKeyForModel({ model: MODEL as never })).resolves.toMatchObject({
      apiKey: "model-key",
    });
    await expect(resolveApiKeyForProvider({ provider: "openai" })).resolves.toMatchObject({
      apiKey: "provider-key",
    });
  });
});
