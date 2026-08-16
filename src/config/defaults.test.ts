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
  applyModelDefaults,
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

  it("preserves pricingUnavailable provenance through model defaults", () => {
    const next = applyModelDefaults({
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            models: [
              {
                id: "gpt-unknown",
                name: "gpt-unknown",
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  pricingUnavailable: true,
                },
              },
            ],
          },
        },
      },
    } as never);

    const model = next.models?.providers?.openai?.models?.find(
      (entry) => entry.id === "gpt-unknown",
    );
    // Placeholder-zero pricing must keep its unknown-pricing provenance
    // through config materialization, or it turns back into a confident $0.
    expect(model?.cost).toMatchObject({ pricingUnavailable: true });
  });

  it("marks an omitted model cost block as pricingUnavailable through model defaults", () => {
    const next = applyModelDefaults({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com",
            models: [
              { id: "gpt-no-cost", name: "gpt-no-cost" },
              { id: "gpt-empty-cost", name: "gpt-empty-cost", cost: {} },
              {
                id: "gpt-empty-tiers",
                name: "gpt-empty-tiers",
                cost: { tieredPricing: [] },
              },
              {
                id: "gpt-free",
                name: "gpt-free",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
              {
                id: "gpt-partial",
                name: "gpt-partial",
                cost: { input: 0.5 },
              },
            ],
          },
        },
      },
    } as never);

    const models = next.models?.providers?.openai?.models ?? [];
    // An omitted or rate-less cost block defaults to all-zero rates; those
    // defaults are unknown pricing, not a confirmed free price, so the
    // materialized entry must carry the marker or downstream consumers
    // report a confident $0. An empty tieredPricing list carries no rates —
    // normalization drops it — so it is unknown pricing too.
    expect(models.find((entry) => entry.id === "gpt-no-cost")?.cost).toMatchObject({
      pricingUnavailable: true,
    });
    expect(models.find((entry) => entry.id === "gpt-empty-cost")?.cost).toMatchObject({
      pricingUnavailable: true,
    });
    expect(models.find((entry) => entry.id === "gpt-empty-tiers")?.cost).toMatchObject({
      pricingUnavailable: true,
    });
    // Explicitly configured all-zero pricing stays unmarked: confirmed free.
    const explicitFree = models.find((entry) => entry.id === "gpt-free")?.cost;
    expect(explicitFree).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(explicitFree).not.toHaveProperty("pricingUnavailable");
    // A block with at least one configured rate is known pricing.
    expect(models.find((entry) => entry.id === "gpt-partial")?.cost).not.toHaveProperty(
      "pricingUnavailable",
    );
  });
});
