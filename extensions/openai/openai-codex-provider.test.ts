import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());
const loginOpenAICodexDeviceCodeMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

vi.mock("./openai-codex-device-code.js", () => ({
  loginOpenAICodexDeviceCode: loginOpenAICodexDeviceCodeMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

function createCodexTemplate(overrides: {
  id?: string;
  name?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  contextTokens?: number;
}) {
  return {
    id: overrides.id ?? "gpt-5.3-codex",
    name: overrides.name ?? overrides.id ?? "gpt-5.3-codex",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"] as const,
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 272_000,
    ...(overrides.contextTokens === undefined ? {} : { contextTokens: overrides.contextTokens }),
    maxTokens: 128_000,
  };
}

function createSingleModelRegistry(
  template: ReturnType<typeof createCodexTemplate>,
  missValue?: null,
) {
  return {
    find: (providerId: string, modelId: string) =>
      providerId === "openai-codex" && modelId === template.id ? template : missValue,
  };
}

describe("openai codex provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
    loginOpenAICodexDeviceCodeMock.mockReset();
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

  it("exposes grouped model/auth picker labels for Codex auth methods", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const oauth = provider.auth?.find((method) => method.id === "oauth");
    const deviceCode = provider.auth?.find((method) => method.id === "device-code");

    expect(oauth?.wizard).toMatchObject({
      choiceLabel: "OpenAI Codex Browser Login",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
    });
    expect(deviceCode?.wizard).toMatchObject({
      choiceLabel: "OpenAI Codex Device Pairing",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
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

  it("declares the legacy default OAuth profile repair", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(provider.oauthProfileIdRepairs).toEqual([
      {
        legacyProfileId: "openai-codex:default",
        promptLabel: "OpenAI Codex",
      },
    ]);
  });

  it("offers OpenAI menu auth methods for browser login and device pairing", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(provider.auth?.map((method) => method.id)).toEqual(["oauth", "device-code"]);
    expect(provider.auth?.find((method) => method.id === "oauth")).toMatchObject({
      label: "OpenAI Codex Browser Login",
      hint: "Sign in with OpenAI in your browser",
      wizard: {
        choiceId: "openai-codex",
        choiceLabel: "OpenAI Codex Browser Login",
        assistantPriority: -30,
      },
    });
    expect(provider.auth?.find((method) => method.id === "device-code")).toMatchObject({
      label: "OpenAI Codex Device Pairing",
      hint: "Pair in browser with a device code",
      kind: "device_code",
      wizard: {
        choiceId: "openai-codex-device-code",
        choiceLabel: "OpenAI Codex Device Pairing",
        assistantPriority: -10,
      },
    });
  });

  it("stores device-code logins as OpenAI Codex oauth profiles", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const deviceCodeMethod = provider.auth?.find((method) => method.id === "device-code");
    const note = vi.fn(async () => {});
    const progress = { update: vi.fn(), stop: vi.fn() };
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce({
      access:
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1kZXZpY2UtMTIzIn19.signature",
      refresh: "device-refresh-token",
      expires: Date.now() + 60_000,
    });

    const result = await deviceCodeMethod?.run({
      config: {},
      env: process.env,
      prompter: {
        note,
        progress: vi.fn(() => progress),
      } as never,
      runtime: runtime as never,
      isRemote: false,
      openUrl: async () => {},
      oauth: { createVpsAwareHandlers: (() => ({})) as never },
    });

    expect(loginOpenAICodexDeviceCodeMock).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalledWith(
      "Trouble with device code login? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
    expect(result).toMatchObject({
      profiles: [
        {
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access:
              "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1kZXZpY2UtMTIzIn19.signature",
            refresh: "device-refresh-token",
            accountId: "acct-device-123",
          },
        },
      ],
      defaultModel: "openai-codex/gpt-5.5",
    });
    expect(result?.profiles[0]?.credential).not.toHaveProperty("idToken");
  });

  async function runRemoteDeviceCodeAuthFlow() {
    const provider = buildOpenAICodexProviderPlugin();
    const deviceCodeMethod = provider.auth?.find((method) => method.id === "device-code");
    const note = vi.fn(async () => {});
    const progress = { update: vi.fn(), stop: vi.fn() };
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    loginOpenAICodexDeviceCodeMock.mockImplementationOnce(async ({ onVerification }) => {
      await onVerification({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-12345",
        expiresInMs: 900_000,
      });
      return {
        access:
          "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1kZXZpY2UtMTIzIn19.signature",
        refresh: "device-refresh-token",
        expires: Date.now() + 60_000,
      };
    });

    await expect(
      deviceCodeMethod?.run({
        config: {},
        env: process.env,
        prompter: {
          note,
          progress: vi.fn(() => progress),
        } as never,
        runtime: runtime as never,
        isRemote: true,
        openUrl: async () => {},
        oauth: { createVpsAwareHandlers: (() => ({})) as never },
      }),
    ).resolves.toBeDefined();

    return { note, runtime };
  }

  it("surfaces the device pairing code via the prompter note in remote (SSH) mode (#74212)", async () => {
    const { note } = await runRemoteDeviceCodeAuthFlow();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Code: CODE-12345"),
      "OpenAI Codex device code",
    );
    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("Code: [shown on the local device only]"),
      "OpenAI Codex device code",
    );
  });

  it("does not write the device pairing code to the runtime log in remote mode", async () => {
    const { runtime } = await runRemoteDeviceCodeAuthFlow();

    const logOutput = runtime.log.mock.calls.flat().join("\n");
    expect(logOutput).toContain("https://auth.openai.com/codex/device");
    expect(logOutput).not.toContain("CODE-12345");
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
      modelRegistry: createSingleModelRegistry(createCodexTemplate({})) as never,
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
      modelRegistry: createSingleModelRegistry(createCodexTemplate({})) as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4-pro",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("keeps Pi cost metadata but applies Codex context metadata for gpt-5.5", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      modelRegistry: createSingleModelRegistry(
        createCodexTemplate({
          id: "gpt-5.5",
          cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
          contextWindow: 272_000,
        }),
      ) as never,
    });
    const pro = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5-pro",
      modelRegistry: createSingleModelRegistry(createCodexTemplate({ id: "gpt-5.4-pro" })) as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.5",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(pro).toMatchObject({
      id: "gpt-5.5-pro",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("synthesizes gpt-5.5 when the Codex catalog omits the OAuth row", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      modelRegistry: createSingleModelRegistry(createCodexTemplate({}), null) as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.5",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("honors providerConfig.baseUrl in the gpt-5.5 synthesis fallback", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      modelRegistry: createSingleModelRegistry(createCodexTemplate({}), null) as never,
      providerConfig: { baseUrl: "http://proxy.local:30400" },
    });

    expect(model).toMatchObject({
      id: "gpt-5.5",
      api: "openai-codex-responses",
      baseUrl: "http://proxy.local:30400",
    });
  });

  it("honors providerConfig.baseUrl in the gpt-5.4 synthesis fallback", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const emptyRegistry = { find: () => null };

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelRegistry: emptyRegistry as never,
      providerConfig: { baseUrl: "http://proxy.local:30400" },
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "http://proxy.local:30400",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-pro from a gpt-5.4 runtime template when legacy codex rows are absent", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-pro",
      modelRegistry: createSingleModelRegistry(
        createCodexTemplate({
          id: "gpt-5.4",
          cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
          contextWindow: 1_050_000,
          contextTokens: 272_000,
        }),
      ) as never,
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
      modelRegistry: createSingleModelRegistry(createCodexTemplate({})) as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.4",
      name: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-mini through the Codex OAuth route", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      modelRegistry: createSingleModelRegistry(
        createCodexTemplate({
          id: "gpt-5.4",
          cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
          contextWindow: 1_050_000,
          contextTokens: 272_000,
        }),
        null,
      ) as never,
    } as never);

    expect(model).toMatchObject({
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    });
  });

  it("augments catalog with gpt-5.5-pro and gpt-5.4 native metadata", () => {
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

    expect(entries).not.toContainEqual(
      expect.objectContaining({
        id: "gpt-5.5",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.5-pro",
        contextWindow: 1_000_000,
        contextTokens: 272_000,
        cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      }),
    );
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
        contextWindow: 400_000,
        contextTokens: 272_000,
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("normalizes legacy completions metadata to the codex transport", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("normalizes legacy GitHub Copilot Codex metadata to the codex transport", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com",
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("normalizes transport metadata for legacy completions codex routes", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.normalizeTransport?.({
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      } as never),
    ).toEqual({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("normalizes transport metadata for legacy GitHub Copilot Codex routes", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.normalizeTransport?.({
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com/v1",
      } as never),
    ).toEqual({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("leaves custom proxy completions transport metadata unchanged", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.normalizeTransport?.({
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      } as never),
    ).toBeUndefined();
  });
});
