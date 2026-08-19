// Verifies default config values and environment-sensitive overrides.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
} from "./agent-limits.js";
import {
  applyAgentDefaults,
  applyContextPruningDefaults,
  applyMessageDefaults,
} from "./defaults.js";

const mocks = vi.hoisted(() => ({
  applyProviderConfigDefaultsForConfig: vi.fn(),
}));

vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (
    ...args: Parameters<typeof mocks.applyProviderConfigDefaultsForConfig>
  ) => mocks.applyProviderConfigDefaultsForConfig(...args),
  normalizeProviderConfigForConfigDefaults: (_params: { providerConfig: unknown }) =>
    _params.providerConfig,
}));

describe("config defaults", () => {
  beforeEach(() => {
    mocks.applyProviderConfigDefaultsForConfig.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips provider defaults when agent defaults are absent", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
          },
        },
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
  });

  it("skips provider defaults when agent defaults have no Anthropic auth signal", () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
  });

  it("uses anthropic provider defaults when agent defaults and auth signal exist", () => {
    const cfg = {
      auth: {
        profiles: {
          anthropic: { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {},
      },
    };
    const nextCfg = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
          },
        },
      },
    };
    mocks.applyProviderConfigDefaultsForConfig.mockReturnValue(nextCfg);

    const manifestRegistry = { plugins: [] };
    expect(applyContextPruningDefaults(cfg as never, { manifestRegistry })).toBe(nextCfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).toHaveBeenCalledTimes(1);
    const [defaultsParams] = expectDefined(
      (
        mocks.applyProviderConfigDefaultsForConfig.mock.calls as unknown as Array<
          [{ manifestRegistry?: unknown }]
        >
      )[0],
      "(mocks.applyProviderConfigDefaultsForConfig.mock.calls as unknown as Array<\n        [{ manifestRegistry?: unknown }]\n      >)[0] test invariant",
    );
    expect(defaultsParams.manifestRegistry).toBe(manifestRegistry);
  });

  it("defaults ackReactionScope without deriving other message fields", () => {
    const next = applyMessageDefaults({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha",
              theme: "helpful sloth",
              emoji: "🦥",
            },
          },
        ],
      },
      messages: {},
    } as never);

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
    expect(next.messages).not.toHaveProperty("responsePrefix");
    expect(next.messages?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("fills missing agent concurrency defaults", () => {
    const next = applyAgentDefaults({ messages: {} } as never);

    expect(next.agents?.defaults?.maxConcurrent).toBe(resolveAgentMaxConcurrent());
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    expect(next.agents?.defaults?.subagents?.archiveAfterMinutes).toBe(
      DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
    );
  });

  it("preserves explicit subagent archive default", () => {
    const next = applyAgentDefaults({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    } as never);

    expect(next.agents?.defaults?.subagents?.archiveAfterMinutes).toBe(0);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});

describe("applyModelDefaults catalog seeding", () => {
  const catalogRegistry = {
    plugins: [
      {
        id: "openai",
        modelCatalog: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "GPT-5.6 Sol",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 400_000,
                  contextTokens: 272_000,
                  maxTokens: 128_000,
                  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
                  thinkingLevelMap: { off: "none" },
                },
              ],
            },
          },
        },
      },
    ],
    // SAFETY: minimal manifest record carrying only the fields applyModelDefaults reads.
  } as never;

  // Regression: an override entry pinning only sizing fields materialized as a
  // text-only, non-reasoning, zero-cost model, silently dropping vision-gated
  // tools (like `computer`) for that model downstream.
  it("fills omitted fields from the owning catalog row before generic defaults", async () => {
    const { applyModelDefaults } = await import("./defaults.js");
    const cfg = applyModelDefaults(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                // SAFETY: mirrors a real operator config entry that omits input/reasoning/cost.
                {
                  id: "gpt-5.6-sol",
                  name: "GPT-5.6",
                  contextWindow: 1_050_000,
                  contextTokens: 922_000,
                } as never,
              ],
            },
          },
        },
      },
      { manifestRegistry: catalogRegistry },
    );
    const model = expectDefined(
      cfg.models?.providers?.openai?.models?.[0],
      "materialized model entry",
    );
    expect(model.input).toEqual(["text", "image"]);
    expect(model.reasoning).toBe(true);
    expect(model.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(model.maxTokens).toBe(128_000);
    expect(model.thinkingLevelMap).toEqual({ off: "none" });
    // Authored fields stay authoritative.
    expect(model.contextWindow).toBe(1_050_000);
    expect(model.contextTokens).toBe(922_000);
    expect(model.name).toBe("GPT-5.6");
  });

  it("keeps authored metadata authoritative over the catalog row", async () => {
    const { applyModelDefaults } = await import("./defaults.js");
    const cfg = applyModelDefaults(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "text-only override",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8_192,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      },
      { manifestRegistry: catalogRegistry },
    );
    const model = expectDefined(
      cfg.models?.providers?.openai?.models?.[0],
      "materialized model entry",
    );
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
    expect(model.maxTokens).toBe(4_096);
  });

  it("preserves catalog tiered pricing when flat cost fields are authored", async () => {
    const { applyModelDefaults } = await import("./defaults.js");
    const tieredRegistry = {
      plugins: [
        {
          id: "openai",
          modelCatalog: {
            providers: {
              openai: {
                models: [
                  {
                    id: "gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    input: ["text", "image"],
                    cost: {
                      input: 5,
                      output: 30,
                      cacheRead: 0.5,
                      cacheWrite: 6.25,
                      tieredPricing: [
                        {
                          input: 2.5,
                          output: 15,
                          cacheRead: 0.25,
                          cacheWrite: 3,
                          maxInputTokens: 200_000,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
      // SAFETY: minimal manifest record carrying only the fields applyModelDefaults reads.
    } as never;
    const cfg = applyModelDefaults(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                // SAFETY: mirrors an operator override with explicit flat cost only.
                {
                  id: "gpt-5.6-sol",
                  name: "GPT-5.6",
                  cost: { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
                } as never,
              ],
            },
          },
        },
      },
      { manifestRegistry: tieredRegistry },
    );
    const model = expectDefined(
      cfg.models?.providers?.openai?.models?.[0],
      "materialized model entry",
    );
    expect(model.cost?.input).toBe(4);
    expect(model.cost?.tieredPricing).toHaveLength(1);
    expect(model.input).toEqual(["text", "image"]);
  });

  it("copies frozen catalog metadata before downstream normalization", async () => {
    const supportedReasoningEfforts = Object.freeze(["low", "high"]);
    const compat = Object.freeze({ supportedReasoningEfforts });
    const frozenRegistry = {
      plugins: [
        {
          id: "openai",
          modelCatalog: {
            providers: {
              openai: {
                models: [
                  Object.freeze({
                    id: "gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    reasoning: true,
                    compat,
                  }),
                ],
              },
            },
          },
        },
      ],
      // SAFETY: minimal frozen manifest record reproducing production registry ownership.
    } as never;
    const { applyModelDefaults } = await import("./defaults.js");
    const cfg = applyModelDefaults(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.6-sol", name: "GPT-5.6" } as never],
            },
          },
        },
      },
      { manifestRegistry: frozenRegistry },
    );
    const model = expectDefined(
      cfg.models?.providers?.openai?.models?.[0],
      "materialized model entry",
    );

    expect(() => {
      model.compat!.supportedReasoningEfforts = ["low"];
    }).not.toThrow();
    expect(compat.supportedReasoningEfforts).toEqual(["low", "high"]);
  });

  it("falls back to generic defaults when no catalog row matches", async () => {
    const { applyModelDefaults } = await import("./defaults.js");
    const cfg = applyModelDefaults(
      {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example.com/v1",
              models: [
                // SAFETY: mirrors a real operator config entry that omits input/reasoning/cost.
                { id: "house-model", name: "House Model" } as never,
              ],
            },
          },
        },
      },
      { manifestRegistry: catalogRegistry },
    );
    const model = expectDefined(
      cfg.models?.providers?.custom?.models?.[0],
      "materialized model entry",
    );
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
  });
});
