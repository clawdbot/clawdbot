// Openai tests cover openai chatgpt provider plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());
const loginOpenAICodexDeviceCodeMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

vi.mock("./openai-chatgpt-device-code.js", () => ({
  loginOpenAICodexDeviceCode: loginOpenAICodexDeviceCodeMock,
}));

let buildOpenAIProvider: typeof import("./openai-provider.js").buildOpenAIProvider;

describe("OpenAI provider Codex transport hooks", () => {
  beforeAll(async () => {
    ({ buildOpenAIProvider } = await import("./openai-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
    loginOpenAICodexDeviceCodeMock.mockReset();
  });

  it("exposes ChatGPT OAuth on the canonical OpenAI provider", () => {
    const provider = buildOpenAIProvider();

    expect(provider.id).toBe("openai");
    expect(provider.aliases).toBeUndefined();
    expect(provider.hookAliases).toEqual(["azure-openai", "azure-openai-responses"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["oauth", "device-code", "api-key"]);
    expect(provider.auth?.map((method) => method.wizard?.choiceId)).toEqual([
      "openai",
      "openai-device-code",
      "openai-api-key",
    ]);
    expect(provider.oauthProfileIdRepairs).toBeUndefined();
  });

  it("stores device-code logins as OpenAI OAuth profiles", async () => {
    const provider = buildOpenAIProvider();
    const deviceCodeMethod = provider.auth?.find((method) => method.id === "device-code");
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
    });

    const result = await deviceCodeMethod?.run({
      isRemote: false,
      openUrl: vi.fn(async () => {}),
      prompter: {
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
      runtime: { log: vi.fn(), error: vi.fn() },
      config: {},
      oauth: {},
    } as never);

    expect(result?.profiles?.[0]).toMatchObject({
      profileId: "openai:default",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
      },
    });
  });

  it("routes Codex-backed OpenAI models through the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("keeps default Codex-backed OpenAI catalog models on the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: {
        find: () => ({
          provider: "openai",
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 400_000,
          maxTokens: 128_000,
        }),
      },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("keeps cloned Codex-backed OpenAI models on the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: {
        find: () => ({
          provider: "openai",
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }),
      },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("refreshes ChatGPT OAuth credentials under the OpenAI provider", async () => {
    const provider = buildOpenAIProvider();
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "new-access",
      refresh: "new-refresh",
      expires: 1_700_000_000_000,
    });

    await expect(
      provider.refreshOAuth?.({
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 60_000,
      }),
    ).resolves.toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "new-access",
      refresh: "new-refresh",
    });
  });
});
