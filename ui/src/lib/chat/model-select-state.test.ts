// @vitest-environment node
// Control UI tests cover chat model select state behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import {
  resolveChatModelUnavailableReason,
  resolveChatFastModeSelectState,
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  const sessionsResult =
    params.sessionsResult ?? createSessionsListResult({ model: null, modelProvider: null });
  return {
    activeSession: params.activeSession ?? sessionsResult.sessions[0],
    sessionKey: "main",
    modelOverrides: {},
    chatModelCatalog: [],
    sessionsResult,
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
  const session = expectDefined(sessionsResult.sessions[0], "fast-mode session fixture");
  sessionsResult.sessions[0] = {
    ...session,
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
    fastModeTarget: sessionsResult.sessions[0],
    gatewayAvailable: true,
    loading: false,
    sending: false,
    sessionsResult,
    stream: null,
  });
}

describe("chat-model-select-state", () => {
  it.each([
    { reason: "missing-auth", expected: "missing-auth" },
    { reason: "auth-failed", expected: "auth-failed" },
    { reason: "cooldown", expected: "cooldown" },
    { reason: undefined, expected: undefined },
  ] as const)("preserves the recorded $reason availability reason", ({ reason, expected }) => {
    const catalog = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: reason,
      },
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    expect(resolveChatModelUnavailableReason("other-model", "openai", catalog)).toBeUndefined();
  });

  it.each([
    { available: true, reason: undefined, expected: undefined },
    { available: undefined, reason: undefined, expected: undefined },
    { available: false, reason: undefined, expected: undefined },
    { available: false, reason: "cooldown", expected: "cooldown" },
    { available: false, reason: "missing-auth", expected: "auth-failed" },
  ] as const)(
    "does not let an auth-failed alias override a $reason/$available route",
    ({ available, reason, expected }) => {
      const catalog = [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "codex",
          available: false,
          unavailableReason: "auth-failed" as const,
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available,
          unavailableReason: reason,
        },
      ];
      expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    },
  );

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

  it("finds the active row across the legacy main alias window", () => {
    // Pre-hello (or legacy-alias) states select "main" while the row list
    // already carries the canonical agent:main:main key; a strict compare
    // missed the row and the picker fell back to the agent default.
    const sessionsResult = createSessionsListResult({
      model: "gpt-5.3-codex",
      modelProvider: "openai",
    });
    const session = expectDefined(sessionsResult.sessions[0], "alias fixture row");
    sessionsResult.sessions[0] = { ...session, key: "agent:main:main" };
    const value = resolveChatModelOverrideValue(
      createChatModelState({
        chatModelCatalog: DEFAULT_CHAT_MODEL_CATALOG,
        sessionsResult,
      }),
    );
    expect(value).toBe("openai/gpt-5.3-codex");
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

  it("keeps the active model value but does not synthesize a picker option when the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
  });

  it("does not synthesize configured models outside catalog results", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
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

  it("keeps configured unavailable catalog entries visible but disabled", () => {
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
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5.5", label: "GPT-5.5" },
      {
        value: "codex/gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        disabled: true,
      },
    ]);
  });

  it.each([
    {
      name: "available",
      available: true,
      options: [{ value: "openai/gpt-5.5", label: "GPT-5.5" }],
    },
    {
      name: "indeterminate",
      available: undefined,
      options: [{ value: "openai/gpt-5.5", label: "GPT-5.5" }],
    },
    {
      name: "all-cold",
      available: false,
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · openai", disabled: true },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
      ],
    },
  ])(
    "preserves $name route labels and options beside a cold legacy alias",
    ({ available, options }) => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            available,
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
      expect(resolved.options).toEqual(options);
    },
  );

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

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expect(resolved.options).toEqual([
      {
        value: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        disabled: true,
        unavailableReason: "missing-auth",
      },
      {
        value: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        disabled: true,
        unavailableReason: "missing-auth",
      },
    ]);
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
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
        sessionsResult,
        stream: null,
      }).supported,
    ).toBe(true);
  });

  it.each([
    { name: "missing", providers: [] },
    { name: "ambiguous", providers: ["xai", "proxy"] },
  ])("uses the session provider with a $name raw-id catalog", ({ providers }) => {
    const model = "google/gemma-4-26b-a4b-it";
    const sessionsResult = createSessionsListResult({
      model,
      modelProvider: "xai",
      defaultsModel: model,
      defaultsProvider: "xai",
    });

    expect(
      resolveChatFastModeSelectState({
        activeRunId: null,
        catalog: providers.map((provider) => ({ id: model, name: "Gemma", provider })),
        connected: true,
        currentModelOverride: model,
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
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
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
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
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
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
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
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
        fastModeTarget: sessionsResult.sessions[0],
        gatewayAvailable: true,
        loading: false,
        sending: false,
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

  it("keeps versioned catalog names visible for configured family aliases", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-opus-4-8",
          alias: "opus",
          name: "Opus 4.8",
          provider: "anthropic",
        },
        {
          id: "claude-sonnet-5",
          alias: "sonnet",
          name: "Sonnet 5",
          provider: "anthropic",
        },
        {
          id: "moonshotai/kimi-k2.5",
          alias: "Kimi K2.5 (NVIDIA)",
          name: "Kimi K2.5",
          provider: "nvidia",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-opus-4-8",
        modelProvider: "anthropic",
        defaultsModel: "claude-opus-4-8",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (Opus 4.8 · opus)");
    expect(resolved.options).toEqual([
      { value: "anthropic/claude-opus-4-8", label: "Opus 4.8 · opus" },
      { value: "anthropic/claude-sonnet-5", label: "Sonnet 5 · sonnet" },
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

  it("keeps a canonical agent default as one named picker option", () => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" }]);
  });

  // The session model equals the agent default in every case, so anything other than
  // the recorded marker would have to guess — and would always guess "inherited".
  it.each([
    { name: "inherited default", source: null, expected: null },
    { name: "user pin the default grew into", source: "user" as const, expected: "user" },
    { name: "automatic fallback", source: "auto" as const, expected: "auto" },
  ])("resolves $expected from provenance for $name", ({ source, expected }) => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        modelOverrideSource: source,
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.6-sol");
    expect(resolved.modelOverrideSource).toBe(expected);
  });

  it("reads pin provenance from a canonical main row when the route uses the alias key", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user",
      }),
    });
    // Route key stays the `main` alias while the Gateway reports the canonical row.
    expectDefined(state.sessionsResult?.sessions[0], "main session row").key = "agent:main:main";

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.modelOverrideSource).toBe("user");
  });

  // `currentOverride` already lets a pending local selection outrank the row, so
  // provenance has to follow it — otherwise the picker would report a model and an
  // origin belonging to two different points in time.
  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = createChatModelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: createSessionsListResult({
        model: "gpt-5",
        modelProvider: "openai",
        modelOverrideSource: null,
      }),
    });

    expect(resolveChatModelSelectState(pendingPin).currentOverride).toBe("openai/gpt-5-mini");
    expect(resolveChatModelSelectState(pendingPin).modelOverrideSource).toBe("user");

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user" as const,
      }),
    };

    expect(resolveChatModelSelectState(pendingReset).currentOverride).toBe("");
    expect(resolveChatModelSelectState(pendingReset).modelOverrideSource).toBeNull();
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
