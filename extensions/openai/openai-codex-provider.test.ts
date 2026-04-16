import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai codex provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  });

  it("falls back to the cached credential when accountId extraction fails", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });

  it("rethrows unrelated refresh failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow("invalid_grant");
  });

  it("merges refreshed oauth credentials", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
      email: "user@example.com",
      displayName: "User",
    };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "next-access",
      refresh: "next-refresh",
      expires: expect.any(Number),
    });
  });

  it("returns deprecated-profile doctor guidance for legacy Codex CLI ids", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildAuthDoctorHint?.({
        provider: "openai-codex",
        profileId: "openai-codex:codex-cli",
        config: undefined,
        store: { version: 1, profiles: {} },
      }),
    ).toBe(
      "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.",
    );
  });

  it("owns native reasoning output mode for Codex responses", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("resolves gpt-5.4 with native contextWindow plus default contextTokens cap", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              id: "gpt-5.3-codex",
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-pro with pro pricing and codex-sized limits", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-pro",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              id: "gpt-5.3-codex",
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4-pro",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("resolves gpt-5.4-pro from a gpt-5.4 runtime template when legacy codex rows are absent", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-pro",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.4") {
            return {
              id: "gpt-5.4",
              name: "gpt-5.4",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"] as const,
              cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
              contextWindow: 1_050_000,
              contextTokens: 272_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4-pro",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("resolves the legacy gpt-5.4-codex alias to canonical gpt-5.4", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-codex",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              id: "gpt-5.3-codex",
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"] as const,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return undefined;
        },
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      name: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-mini from codex templates with codex-sized limits", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.1-codex-mini") {
            return {
              id: "gpt-5.1-codex-mini",
              name: "gpt-5.1-codex-mini",
              provider: "openai-codex",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            };
          }
          return null;
        },
      } as never,
    } as never);

    expect(model).toMatchObject({
      id: "gpt-5.4-mini",
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    });
    expect(model).not.toHaveProperty("contextTokens");
  });

  it("augments catalog with gpt-5.4 native contextWindow and runtime cap", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          id: "gpt-5.3-codex",
          name: "gpt-5.3-codex",
          provider: "openai-codex",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
        },
      ],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4",
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4-pro",
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4-mini",
        contextWindow: 272_000,
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
      }),
    );
  });

  it("augments gpt-5.4-pro from catalog gpt-5.4 when legacy codex rows are absent", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        {
          id: "gpt-5.4",
          name: "gpt-5.4",
          provider: "openai-codex",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
        },
      ],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4-pro",
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      }),
    );
  });

  it("canonicalizes legacy gpt-5.4-codex models during resolved-model normalization", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4-codex",
        name: "gpt-5.4-codex",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      },
    } as never);

    expect(model).toMatchObject({
      id: "gpt-5.4",
      name: "gpt-5.4",
    });
  });

  it("defaults missing codex api metadata to openai-codex-responses", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      },
    } as never);

    expect(model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes stale /backend-api/v1 codex metadata to the canonical base url", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      },
    } as never);

    expect(model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes transport metadata for stale /backend-api/v1 codex routes", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.normalizeTransport?.({
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/v1",
      } as never),
    ).toEqual({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });
});
