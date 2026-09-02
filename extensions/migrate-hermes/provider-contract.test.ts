import { describe, expect, it } from "vitest";
import { collectHermesProviderSecretBindings } from "./config-providers.js";
import { buildConfigItems } from "./config.js";
import { makeContext } from "./test/provider-helpers.js";

const ctx = makeContext({ source: "/hermes", stateDir: "/state", workspaceDir: "/workspace" });

function providerItems(raw: Record<string, unknown>) {
  return buildConfigItems({
    ctx,
    config: { providers: { acme: { api: "https://models.example/v1", ...raw } } },
  });
}

describe("Hermes provider source contracts", () => {
  it.each([
    ["openai", "openai-completions"],
    ["openai-chat", "openai-completions"],
    ["chat-completions", "openai-completions"],
    ["chatcompletions", "openai-completions"],
    ["responses", "openai-responses"],
    ["openai_responses", "openai-responses"],
    ["openai-responses", "openai-responses"],
    ["anthropic", "anthropic-messages"],
    ["anthropic-messages", "anthropic-messages"],
    ["messages", "anthropic-messages"],
    [" CHAT_COMPLETIONS ", "openai-completions"],
  ])("imports Hermes transport alias %s as %s", (transport, api) => {
    const items = providerItems({ transport, default_model: "acme-model" });
    expect(
      items.find((item) => item.id === "config:model-provider:acme")?.details?.value,
    ).toMatchObject({
      acme: { api, models: [{ id: "acme-model", api }] },
    });
    expect(items.filter((item) => item.kind === "manual")).toEqual([]);
  });

  it("honors canonical field precedence while importing documented camelCase fields", () => {
    const config = {
      providers: {
        acme: {
          baseUrl: "https://models.example/v1",
          apiMode: "messages",
          keyEnv: "ACME_TOKEN",
          defaultModel: "acme-model",
          contextLength: 262144,
        },
      },
    };
    const items = buildConfigItems({ ctx, config, env: { ACME_TOKEN: "test-only-placeholder" } });
    expect(
      items.find((item) => item.id === "config:model-provider:acme")?.details?.value,
    ).toMatchObject({
      acme: {
        api: "anthropic-messages",
        models: [{ id: "acme-model", contextWindow: 262144 }],
      },
    });
    expect(collectHermesProviderSecretBindings(config)).toEqual([
      { provider: "acme", envVar: "ACME_TOKEN" },
    ]);
    expect(
      providerItems({ api_mode: "chat_completions", transport: "anthropic_messages" })[0]?.details
        ?.value,
    ).toMatchObject({
      acme: { api: "openai-completions" },
    });
  });

  it("preserves list model metadata and removes Hermes catalog marker keys", () => {
    const arrayItems = providerItems({
      context_length: 32768,
      models: [
        " plain-model ",
        { id: "vision-model", context_length: 65536, max_tokens: 4096, supports_vision: true },
        { name: "named-model", max_tokens: 2048 },
      ],
    });
    expect(arrayItems[0]?.details?.value).toMatchObject({
      acme: {
        models: [
          { id: "plain-model", contextWindow: 32768 },
          { id: "vision-model", contextWindow: 65536, maxTokens: 4096, input: ["text", "image"] },
          { id: "named-model", contextWindow: 32768, maxTokens: 2048 },
        ],
      },
    });
    expect(
      providerItems({
        models: {
          "acme-model": {},
          __discovered_model_catalog__: true,
          __explicit_model_allowlist__: true,
        },
      })[0]?.details?.value,
    ).toMatchObject({
      acme: { models: [{ id: "acme-model" }] },
    });
  });
});
