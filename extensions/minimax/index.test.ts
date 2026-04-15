import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { registerMinimaxProviders } from "./provider-registration.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";

vi.mock("./oauth.runtime.js", () => ({
  loginMiniMaxPortalOAuth: vi.fn(async () => ({
    access: "minimax-oauth-access-token",
    refresh: "minimax-oauth-refresh-token",
    expires: Date.now() + 60_000,
    resourceUrl: "https://api.minimax.io/anthropic",
  })),
}));

const minimaxProviderPlugin = {
  register(api: Parameters<typeof registerMinimaxProviders>[0]) {
    registerMinimaxProviders(api);
    api.registerWebSearchProvider(createMiniMaxWebSearchProvider());
  },
};

describe("minimax provider hooks", () => {
  it("keeps native reasoning mode for MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(apiProvider.hookAliases).toContain("minimax-cn");
    expect(
      apiProvider.resolveReasoningOutputMode?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");

    expect(portalProvider.hookAliases).toContain("minimax-portal-cn");
    expect(
      portalProvider.resolveReasoningOutputMode?.({
        provider: "minimax-portal",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");
  });

  it("keeps MiniMax auth setup metadata aligned across regions", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(
      apiProvider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
        groupId: method.wizard?.groupId,
        groupHint: method.wizard?.groupHint,
      })),
    ).toEqual([
      {
        id: "api-global",
        label: "MiniMax API key (Global)",
        hint: "Global endpoint - api.minimax.io",
        choiceId: "minimax-global-api",
        groupId: "minimax",
        groupHint: "M2.7 (recommended)",
      },
      {
        id: "api-cn",
        label: "MiniMax API key (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        choiceId: "minimax-cn-api",
        groupId: "minimax",
        groupHint: "M2.7 (recommended)",
      },
    ]);

    expect(
      portalProvider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
        groupId: method.wizard?.groupId,
        groupHint: method.wizard?.groupHint,
      })),
    ).toEqual([
      {
        id: "oauth",
        label: "MiniMax OAuth (Global)",
        hint: "Global endpoint - api.minimax.io",
        choiceId: "minimax-global-oauth",
        groupId: "minimax",
        groupHint: "M2.7 (recommended)",
      },
      {
        id: "oauth-cn",
        label: "MiniMax OAuth (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        choiceId: "minimax-cn-oauth",
        groupId: "minimax",
        groupHint: "M2.7 (recommended)",
      },
    ]);
  });

  it("owns replay policy for Anthropic and OpenAI-compatible MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(
      apiProvider.buildReplayPolicy?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toMatchObject({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      preserveSignatures: true,
      validateAnthropicTurns: true,
    });

    expect(
      portalProvider.buildReplayPolicy?.({
        provider: "minimax-portal",
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("owns fast-mode stream wrapping for MiniMax transports", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    let resolvedApiModelId = "";
    const captureApiModel: StreamFn = (model) => {
      resolvedApiModelId = model.id ?? "";
      return {} as ReturnType<StreamFn>;
    };
    const wrappedApiStream = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: captureApiModel,
    } as never);

    void wrappedApiStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    let resolvedPortalModelId = "";
    const capturePortalModel: StreamFn = (model) => {
      resolvedPortalModelId = model.id ?? "";
      return {} as ReturnType<StreamFn>;
    };
    const wrappedPortalStream = portalProvider.wrapStreamFn?.({
      provider: "minimax-portal",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: capturePortalModel,
    } as never);

    void wrappedPortalStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax-portal",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(resolvedApiModelId).toBe("MiniMax-M2.7-highspeed");
    expect(resolvedPortalModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("shares the provider hook bundle across MiniMax variants", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(apiProvider.buildReplayPolicy).toBe(portalProvider.buildReplayPolicy);
    expect(apiProvider.wrapStreamFn).toBe(portalProvider.wrapStreamFn);
    expect(apiProvider.resolveReasoningOutputMode).toBe(portalProvider.resolveReasoningOutputMode);
  });

  it("registers the bundled MiniMax web search provider", () => {
    const webSearchProviders: unknown[] = [];

    minimaxProviderPlugin.register({
      registerProvider() {},
      registerMediaUnderstandingProvider() {},
      registerImageGenerationProvider() {},
      registerMusicGenerationProvider() {},
      registerVideoGenerationProvider() {},
      registerSpeechProvider() {},
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(webSearchProviders).toHaveLength(1);
    expect(webSearchProviders[0]).toMatchObject({
      id: "minimax",
      label: "MiniMax Search",
      envVars: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"],
    });
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyFromConfigAndStore = vi.fn(() => undefined);

    await expect(
      apiProvider.resolveUsageAuth?.({
        provider: "minimax",
        config: {},
        env: {},
        resolveOAuthToken,
        resolveApiKeyFromConfigAndStore,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveOAuthToken).toHaveBeenCalledWith({ provider: "minimax-portal" });
    expect(resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
  });

  it("writes api and authHeader into the MiniMax portal OAuth config patch", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: minimaxProviderPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");
    const oauthMethod = portalProvider.auth.find((method) => method.id === "oauth");

    expect(oauthMethod).toBeDefined();

    const result = await oauthMethod?.run({
      prompter: {
        progress() {
          return { stop() {} };
        },
        note: vi.fn(async () => undefined),
      },
      openUrl: vi.fn(async () => undefined),
    } as never);

    expect(result?.configPatch?.models?.providers?.["minimax-portal"]).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
    });
  });
});
