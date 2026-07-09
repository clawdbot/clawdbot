// Control UI tests cover chat model select state behavior.
import { describe, expect, it } from "vitest";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  return {
    sessionKey: "main",
    modelOverrides: {},
    chatModelCatalog: [],
    sessionsResult: createSessionsListResult({ model: null, modelProvider: null }),
    ...params,
  };
}

function resolveFastModeState(params: {
  provider: string;
  fastMode?: boolean | "auto";
  effectiveFastMode?: boolean | "auto";
}) {
  const sessionsResult = createSessionsListResult({
    model: "model",
    modelProvider: params.provider,
  });
  sessionsResult.sessions[0] = {
    ...sessionsResult.sessions[0],
    ...(params.fastMode === undefined ? {} : { fastMode: params.fastMode }),
    ...(params.effectiveFastMode === undefined
      ? {}
      : { effectiveFastMode: params.effectiveFastMode }),
  };
  return resolveChatFastModeSelectState({
    activeRunId: null,
    catalog: [],
    connected: true,
    currentModelOverride: `${params.provider}/model`,
    gatewayAvailable: true,
    loading: false,
    sending: false,
    sessionKey: "main",
    sessionsResult,
    stream: null,
  });
}

describe("chat-model-select-state", () => {
  it("toggles between Standard and Fast for OpenAI models", () => {
    expect(resolveFastModeState({ provider: "openai" })).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      nextValue: "on",
      supported: true,
    });
    expect(resolveFastModeState({ provider: "openai", fastMode: true })).toMatchObject({
      active: true,
      currentOverride: "on",
      label: "Fast",
      nextValue: "off",
    });
    expect(resolveFastModeState({ provider: "openai", effectiveFastMode: true })).toMatchObject({
      active: true,
      currentOverride: "on",
    });
    expect(resolveFastModeState({ provider: "openai", fastMode: "auto" })).toMatchObject({
      active: true,
      currentOverride: "auto",
      label: "Auto",
      nextValue: "off",
    });
  });

  it("toggles between the inherited default and Fast for other fast-mode providers", () => {
    expect(resolveFastModeState({ provider: "anthropic" })).toMatchObject({
      active: false,
      currentOverride: "",
      label: "Default",
      nextValue: "on",
      supported: true,
    });
    // Turning fast off always writes an explicit off override: the inherited
    // baseline is unknowable while an override exists, and clearing could
    // land on a fast default, turning the click into a visible no-op.
    expect(resolveFastModeState({ provider: "anthropic", fastMode: true })).toMatchObject({
      active: true,
      label: "Fast",
      nextValue: "off",
    });
    expect(resolveFastModeState({ provider: "anthropic", effectiveFastMode: true })).toMatchObject({
      active: true,
      currentOverride: "",
      nextValue: "off",
    });
    expect(resolveFastModeState({ provider: "anthropic", fastMode: false })).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      nextValue: "on",
    });
    expect(resolveFastModeState({ provider: "anthropic", fastMode: "auto" })).toMatchObject({
      active: true,
      currentOverride: "auto",
      label: "Auto",
      nextValue: "off",
    });
  });

  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("normalizes cached bare overrides to the matching catalog option", () => {
    const state = createChatModelState({
      modelOverrides: { main: "gpt-5-mini" },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("prefers catalog provider matches over stale session providers", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    });

    expect(resolveChatModelSelectState(state).currentOverride).toBe("deepseek/deepseek-chat");
  });

  it("preserves already-qualified active-session models when the provider is stale and the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5-mini", label: "gpt-5-mini · openai" },
      { value: "openai/gpt-5", label: "gpt-5 · openai" },
    ]);
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("omits unavailable catalog entries from picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultSelectable).toBe(true);
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.5", label: "GPT-5.5" }]);
  });

  it("keeps an available OpenAI route when an unavailable legacy route has the same model id", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "codex",
          available: false,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "codex",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "codex",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.5");
    expect(resolved.defaultModel).toBe("openai/gpt-5.5");
    expect(resolved.defaultSelectable).toBe(true);
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.5", label: "GPT-5.5" }]);
  });

  it("preserves an exact available OpenAI route when a legacy route is also available", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "codex",
          available: true,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.5");
    expect(resolved.defaultModel).toBe("openai/gpt-5.5");
  });

  it("does not reintroduce an unavailable current or default model", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.3-codex-spark",
        modelProvider: "openai",
        defaultsModel: "gpt-5.3-codex-spark",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultSelectable).toBe(false);
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.5", label: "GPT-5.5" }]);
  });

  it("supports fast mode for a default legacy Codex provider", () => {
    const sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "codex",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "codex",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [],
        connected: true,
        currentModelOverride: "",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(true);
  });

  it("uses the session provider for fast mode with a slash-containing raw model id", () => {
    const sessionsResult = createSessionsListResult({
      model: "google/gemma-4-26b-a4b-it",
      modelProvider: "xai",
      defaultsModel: "google/gemma-4-26b-a4b-it",
      defaultsProvider: "xai",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [],
        connected: true,
        currentModelOverride: "google/gemma-4-26b-a4b-it",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(true);
  });

  it("does not offer the speed toggle for providers without a runtime fast-mode mapping", () => {
    // openrouter is proxied without a fast-mode wire mapping; an enabled
    // toggle there would silently do nothing.
    expect(resolveFastModeState({ provider: "openrouter" })).toMatchObject({
      supported: false,
      disabled: true,
    });
    // Legacy overrides stay visible but the toggle is clear-only: it must
    // never write a fresh no-op fast override for an unmapped provider.
    expect(resolveFastModeState({ provider: "openrouter", fastMode: true })).toMatchObject({
      supported: true,
      active: true,
      nextValue: "",
    });
    expect(resolveFastModeState({ provider: "openrouter", fastMode: false })).toMatchObject({
      supported: true,
      active: false,
      label: "Standard",
      nextValue: "",
    });
  });

  it("uses a catalog-qualified model provider before a stale session runtime provider", () => {
    const sessionsResult = createSessionsListResult({
      model: "claude-opus-4-8",
      modelProvider: "claude-cli",
      defaultsModel: "claude-opus-4-8",
      defaultsProvider: "claude-cli",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            provider: "anthropic",
          },
        ],
        connected: true,
        currentModelOverride: "anthropic/claude-opus-4-8",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(true);
  });

  it("keeps a unique qualified provider when proxy catalogs reuse the nested id", () => {
    const sessionsResult = createSessionsListResult({
      model: "claude-opus-4-8",
      modelProvider: "claude-cli",
      defaultsModel: "claude-opus-4-8",
      defaultsProvider: "claude-cli",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            provider: "anthropic",
          },
          {
            id: "anthropic/claude-opus-4-8",
            name: "Claude Opus 4.8",
            provider: "openrouter",
          },
          {
            id: "anthropic/claude-opus-4-8",
            name: "Claude Opus 4.8",
            provider: "gateway-proxy",
          },
        ],
        connected: true,
        currentModelOverride: "anthropic/claude-opus-4-8",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(true);
  });

  it("prefers an explicit native qualified route over a stale proxy provider hint", () => {
    const sessionsResult = createSessionsListResult({
      model: "google/gemini-2.5-pro",
      modelProvider: "openrouter",
      defaultsModel: "google/gemini-2.5-pro",
      defaultsProvider: "openrouter",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [
          {
            id: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            provider: "google",
          },
          {
            id: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            provider: "openrouter",
          },
        ],
        connected: true,
        currentModelOverride: "google/gemini-2.5-pro",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(false);
  });

  it("does not restore a session provider rejected by relevant catalog metadata", () => {
    const sessionsResult = createSessionsListResult({
      model: "vendor/model",
      modelProvider: "openrouter",
      defaultsModel: "vendor/model",
      defaultsProvider: "openrouter",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: [
          {
            id: "vendor/model",
            name: "Vendor Model",
            provider: "proxy-a",
          },
          {
            id: "vendor/model",
            name: "Vendor Model",
            provider: "proxy-b",
          },
        ],
        connected: true,
        currentModelOverride: "vendor/model",
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionKey: "main",
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(false);
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog({
        id: "moonshotai/kimi-k2.5",
        alias: "Kimi K2.5 (NVIDIA)",
        name: "Kimi K2.5 (NVIDIA)",
        provider: "nvidia",
      }),
      sessionsResult: createSessionsListResult({
        model: "moonshotai/kimi-k2.5",
        modelProvider: "nvidia",
        defaultsModel: "moonshotai/kimi-k2.5",
        defaultsProvider: "nvidia",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toEqual([
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("uses the active agent model for the default label", () => {
    const state = createChatModelState({
      agentDefaultModel: "anthropic/claude-opus-4-5",
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
        },
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        model: "claude-opus-4-5",
        modelProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("anthropic/claude-opus-4-5");
    expect(resolved.defaultLabel).toBe("Default (Claude Opus 4.5)");
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · openrouter)");
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · anthropic",
      },
      {
        value: "openrouter/claude-3-7-sonnet",
        label: "Claude Sonnet · openrouter",
      },
    ]);
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet-thinking",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      },
      {
        value: "anthropic/claude-3-7-sonnet-thinking",
        label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      },
    ]);
  });
});
