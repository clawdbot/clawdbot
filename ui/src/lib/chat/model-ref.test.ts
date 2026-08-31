// @vitest-environment node
// Control UI tests cover chat model ref behavior.
import { describe, expect, it } from "vitest";
import {
  createAmbiguousModelCatalog,
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  OPENAI_GPT5_MINI_MODEL,
} from "../../test-helpers/chat-model.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

const catalog = createModelCatalog(OPENAI_GPT5_MINI_MODEL, {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
});

describe("chat-model-ref helpers", () => {
  it("preserves provider-native nested ids and prefers aliases", () => {
    const nested = {
      id: "moonshotai/kimi-k2.5",
      alias: "Kimi K2.5 (NVIDIA)",
      name: "Kimi K2.5",
      provider: "nvidia",
    };
    const lookup = buildCatalogDisplayLookup([nested]);

    expect(buildChatModelOptionFromLookup(nested, lookup)).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
    expect(formatCatalogChatModelDisplayFromLookup("nvidia/moonshotai/kimi-k2.5", lookup)).toBe(
      "Kimi K2.5 (NVIDIA)",
    );
  });

  it.each([
    {
      id: "claude-opus-4-8",
      name: "Opus 4.8",
      alias: "opus",
      expected: "Opus 4.8 · opus",
    },
    {
      id: "claude-sonnet-5",
      name: "Sonnet 5",
      alias: "sonnet",
      expected: "Sonnet 5 · sonnet",
    },
    {
      id: "claude-sonnet-5",
      name: "Sonnet 5",
      alias: "My preferred model",
      expected: "Sonnet 5 · My preferred model",
    },
  ])(
    "keeps the canonical model name visible beside the $alias selection alias",
    ({ id, name, alias, expected }) => {
      const entry = { id, name, alias, provider: "anthropic" };
      const lookup = buildCatalogDisplayLookup([entry]);

      expect(buildChatModelOptionFromLookup(entry, lookup)).toEqual({
        value: `anthropic/${id}`,
        label: expected,
      });
      expect(formatCatalogChatModelDisplayFromLookup(`anthropic/${id}`, lookup)).toBe(expected);
    },
  );

  it("normalizes raw overrides when the catalog match is unique", () => {
    expect(normalizeChatModelOverrideValue("gpt-5-mini", catalog)).toBe("openai/gpt-5-mini");
  });

  it("keeps ambiguous raw overrides unchanged", () => {
    expect(
      normalizeChatModelOverrideValue(
        "gpt-5-mini",
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toBe("gpt-5-mini");
  });

  it("does not double-prefix provider-native catalog ids", () => {
    expect(buildQualifiedChatModelValue("openrouter/auto", "openrouter")).toBe("openrouter/auto");
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

  it("uses the recorded provider when a slash-containing id exists under multiple providers", () => {
    expect(
      resolvePreferredServerChatModelValue("google/gemma-4-26b-a4b-it", "openrouter", [
        {
          id: "google/gemma-4-26b-a4b-it",
          name: "Gemma 4",
          provider: "google",
        },
        {
          id: "google/gemma-4-26b-a4b-it",
          name: "Gemma 4",
          provider: "openrouter",
        },
      ]),
    ).toBe("openrouter/google/gemma-4-26b-a4b-it");
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
