import { describe, expect, it } from "vitest";
import {
  buildChatModelOption,
  buildQualifiedChatModelValue,
  createChatModelOverride,
  formatCatalogChatModelDisplay,
  formatChatModelDisplay,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
  resolveServerChatModelValue,
} from "./chat-model-ref.ts";
import {
  createAmbiguousModelCatalog,
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  OPENAI_GPT5_MINI_MODEL,
} from "./chat-model.test-helpers.ts";

const catalog = createModelCatalog(OPENAI_GPT5_MINI_MODEL, {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
});

describe("chat-model-ref helpers", () => {
  it("builds provider-qualified option values and prefers catalog names for labels", () => {
    expect(buildChatModelOption(catalog[0], catalog)).toEqual({
      value: "openai/gpt-5-mini",
      label: "GPT-5 Mini",
    });
  });

  it("preserves already-qualified model refs without prepending provider", () => {
    expect(resolveServerChatModelValue("ollama/qwen3:30b", "openai-codex")).toBe(
      "ollama/qwen3:30b",
    );
  });

  it("prefixes provider-native catalog ids that already contain slashes", () => {
    const providerNativeModel = {
      id: "google/gemma-4-26b-a4b-it",
      name: "Gemma 4 26B A4B IT",
      provider: "openrouter",
    };

    expect(buildChatModelOption(providerNativeModel, [providerNativeModel])).toEqual({
      value: "openrouter/google/gemma-4-26b-a4b-it",
      label: "Gemma 4 26B A4B IT",
    });
    expect(
      resolvePreferredServerChatModelValue("google/gemma-4-26b-a4b-it", "openrouter", [
        providerNativeModel,
      ]),
    ).toBe("openrouter/google/gemma-4-26b-a4b-it");
  });

  it("prefers alias over name for picker labels", () => {
    const aliasedModel = {
      id: "moonshotai/kimi-k2.5",
      alias: "Kimi K2.5 (NVIDIA)",
      name: "Kimi K2.5",
      provider: "nvidia",
    };

    expect(buildChatModelOption(aliasedModel, [aliasedModel])).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
    expect(formatCatalogChatModelDisplay("nvidia/moonshotai/kimi-k2.5", [aliasedModel])).toBe(
      "Kimi K2.5 (NVIDIA)",
    );
  });

  it("uses friendly catalog names for qualified nested model ids", () => {
    const nestedModel = {
      id: "moonshotai/kimi-k2.5",
      name: "Kimi K2.5 (NVIDIA)",
      provider: "nvidia",
    };
    expect(buildChatModelOption(nestedModel, [nestedModel])).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
    expect(formatCatalogChatModelDisplay("nvidia/moonshotai/kimi-k2.5", [nestedModel])).toBe(
      "Kimi K2.5 (NVIDIA)",
    );
  });

  it("disambiguates duplicate friendly names with the provider", () => {
    const duplicateNameCatalog = createModelCatalog(
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
    );

    expect(buildChatModelOption(duplicateNameCatalog[0], duplicateNameCatalog)).toEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · anthropic",
    });
    expect(
      formatCatalogChatModelDisplay("openrouter/claude-3-7-sonnet", duplicateNameCatalog),
    ).toBe("Claude Sonnet · openrouter");
  });

  it("falls back to the raw catalog label when name and provider still collide", () => {
    const duplicateNameAndProviderCatalog = createModelCatalog(
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
    );

    expect(
      buildChatModelOption(duplicateNameAndProviderCatalog[0], duplicateNameAndProviderCatalog),
    ).toEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
    });
    expect(
      formatCatalogChatModelDisplay(
        "anthropic/claude-3-7-sonnet-thinking",
        duplicateNameAndProviderCatalog,
      ),
    ).toBe("Claude Sonnet · claude-3-7-sonnet-thinking · anthropic");
  });

  it("normalizes raw overrides when the catalog match is unique", () => {
    expect(normalizeChatModelOverrideValue(createChatModelOverride("gpt-5-mini"), catalog)).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("keeps ambiguous raw overrides unchanged", () => {
    expect(
      normalizeChatModelOverrideValue(
        createChatModelOverride("gpt-5-mini"),
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toBe("gpt-5-mini");
  });

  it("formats qualified model refs consistently for default labels", () => {
    expect(formatChatModelDisplay("openai/gpt-5-mini")).toBe("gpt-5-mini · openai");
    expect(formatChatModelDisplay("alias-only")).toBe("alias-only");
  });

  it("does not double-prefix provider-native catalog ids", () => {
    expect(buildQualifiedChatModelValue("openrouter/auto", "openrouter")).toBe("openrouter/auto");
  });

  it("resolves server session data to qualified option values", () => {
    expect(resolveServerChatModelValue("gpt-5-mini", "openai")).toBe("openai/gpt-5-mini");
    expect(resolveServerChatModelValue("alias-only", null)).toBe("alias-only");
  });

  it("uses the recorded server provider when it is present", () => {
    expect(
      resolvePreferredServerChatModelValue("deepseek-chat", "deepseek", [DEEPSEEK_CHAT_MODEL]),
    ).toBe("deepseek/deepseek-chat");
  });

  it("corrects stale server providers for unique plain-id catalog matches", () => {
    expect(
      resolvePreferredServerChatModelValue("deepseek-chat", "zai", [DEEPSEEK_CHAT_MODEL]),
    ).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server provider when the catalog misses or is ambiguous", () => {
    expect(resolvePreferredServerChatModelValue("gpt-5-mini", "openai", [])).toBe(
      "openai/gpt-5-mini",
    );
    expect(
      resolvePreferredServerChatModelValue(
        "gpt-5-mini",
        "openai",
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toBe("openai/gpt-5-mini");
  });

  it("qualifies slash-containing server model ids with the recorded provider", () => {
    expect(
      resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "nvidia", [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (NVIDIA)",
          provider: "nvidia",
        },
      ]),
    ).toBe("nvidia/moonshotai/kimi-k2.5");
  });

  it("uses the catalog-backed provider for slash-containing nested ids before stale provider fallback", () => {
    expect(
      resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "zai", [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (NVIDIA)",
          provider: "nvidia",
        },
      ]),
    ).toBe("nvidia/moonshotai/kimi-k2.5");
  });

  it("falls back to the server-qualified value for slash-containing ids when the catalog is empty", () => {
    expect(resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "nvidia", [])).toBe(
      "moonshotai/kimi-k2.5",
    );
  });

  it("preserves already-qualified server model values when the provider matches", () => {
    expect(
      resolvePreferredServerChatModelValue("openai/gpt-5-mini", "openai", [OPENAI_GPT5_MINI_MODEL]),
    ).toBe("openai/gpt-5-mini");
  });

  it("preserves already-qualified server model values when the provider is stale", () => {
    expect(
      resolvePreferredServerChatModelValue("openai/gpt-5-mini", "zai", [OPENAI_GPT5_MINI_MODEL]),
    ).toBe("openai/gpt-5-mini");
  });

  it("preserves already-qualified server model values when the provider is stale and the catalog is empty", () => {
    expect(resolvePreferredServerChatModelValue("openai/gpt-5-mini", "zai", [])).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("keeps nested provider-qualified server values stable when the catalog already confirms them", () => {
    const nestedModel = {
      id: "deepseek-ai/deepseek-v3.2",
      name: "DeepSeek V3.2",
      provider: "nvidia",
    };

    expect(
      resolvePreferredServerChatModelValue("nvidia/deepseek-ai/deepseek-v3.2", "nvidia", [
        nestedModel,
      ]),
    ).toBe("nvidia/deepseek-ai/deepseek-v3.2");
  });

  it("uses catalog resolution for provider-less raw server model values", () => {
    expect(resolvePreferredServerChatModelValue("gpt-5-mini", null, [OPENAI_GPT5_MINI_MODEL])).toBe(
      "openai/gpt-5-mini",
    );
  });
});
