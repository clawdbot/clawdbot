import { describe, expect, it } from "vitest";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "./chat-model.test-helpers.ts";

describe("chat-model-select-state", () => {
  it("uses the server-qualified value when the active session provider is present", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: [],
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("normalizes cached bare overrides to the matching catalog option", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: { main: { kind: "raw", value: "gpt-5-mini" } },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({ model: null, modelProvider: null }),
    } as const;

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).not.toContain("gpt-5-mini");
  });

  it("prefers catalog provider matches over stale session providers", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    };

    expect(resolveChatModelSelectState(state).currentOverride).toBe("deepseek/deepseek-chat");
  });

  it("preserves already-qualified active-session models when the provider is stale and the catalog is empty", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: [],
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).not.toContain("zai/openai/gpt-5-mini");
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).not.toContain("gpt-5-mini");
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
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
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toContainEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
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
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · openrouter)");
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · anthropic",
    });
    expect(resolved.options).toContainEqual({
      value: "openrouter/claude-3-7-sonnet",
      label: "Claude Sonnet · openrouter",
    });
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
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
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
    });
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet-thinking",
      label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
    });
  });
});
