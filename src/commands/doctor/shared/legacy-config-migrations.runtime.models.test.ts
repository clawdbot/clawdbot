// Runtime model migration tests cover doctor legacy config migrations for model runtime shape.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, it, expect } from "vitest";
import { createModelVisibilityPolicy } from "../../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import {
  collectBlockedLegacyOpenAICodexProviderPlan,
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS,
} from "./legacy-config-migrations.runtime.models.js";

describe("model compat catalog ownership migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (entry) => entry.id === "models.providers.*.models.*.compat->provider-catalog",
  );

  it("strips matching catalog values and dead keys while preserving divergences", () => {
    const raw = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.6",
                compat: {
                  supportsReasoningEffort: true,
                  supportsTemperature: true,
                  nativeWebSearchTool: true,
                  requiresMistralToolIds: true,
                },
              },
            ],
          },
        },
      },
    };
    const changes: string[] = [];
    const rules = migration?.legacyRules ?? [];

    expect(rules.map((rule) => rule.match?.(raw.models.providers, raw))).toEqual([
      true,
      true,
      true,
    ]);
    migration?.apply(raw, changes);

    expect(raw.models.providers.openai.models[0]?.compat).toEqual({ supportsTemperature: true });
    expect(changes).toEqual([
      "Removed models.providers.openai.models.0.compat catalog/dead overrides: nativeWebSearchTool, requiresMistralToolIds, supportsReasoningEffort.",
    ]);
    expect(rules.map((rule) => rule.match?.(raw.models.providers, raw))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("preserves live compat for custom models and custom routes", () => {
    const raw = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9000/v1",
            models: [{ id: "local-model", compat: { supportsTools: false } }],
          },
          openai: {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:9100/v1",
            models: [{ id: "gpt-5.6", compat: { supportsReasoningEffort: true } }],
          },
        },
      },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw.models.providers.custom.models[0]?.compat).toEqual({ supportsTools: false });
    expect(raw.models.providers.openai.models[0]?.compat).toEqual({
      supportsReasoningEffort: true,
    });
    expect(changes).toEqual([]);
  });
});

describe("explicit model allow policy migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (entry) => entry.id === "agents.defaults.models->agents.defaults.modelPolicy.allow",
  );

  it("preserves a legacy restriction after an unrelated new-version write", () => {
    const raw = {
      meta: { lastTouchedVersion: "2026.7.2" },
      agents: {
        defaults: {
          models: {
            "openai/*": {},
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    };
    const changes: string[] = [];

    expect(migration?.legacyRules?.[0]?.match?.(raw.agents.defaults.models, raw)).toBe(true);
    migration?.apply(raw, changes);

    expect(raw.agents.defaults).toMatchObject({
      modelPolicy: {
        allow: ["openai/*", "anthropic/claude-sonnet-4-6"],
      },
    });
    expect(raw).toMatchObject({
      meta: { migrations: { modelPolicyAllowlist: true } },
    });
    expect(changes).toHaveLength(1);
    expect(migration?.legacyRules?.[0]?.match?.(raw.agents.defaults.models, raw)).toBe(false);

    const migratedDefaults = raw.agents.defaults as typeof raw.agents.defaults & {
      modelPolicy: { allow: string[] };
    };
    migratedDefaults.modelPolicy.allow = ["google/*"];
    const secondChanges: string[] = [];
    migration?.apply(raw, secondChanges);
    expect(migratedDefaults.modelPolicy.allow).toEqual(["google/*"]);
    expect(secondChanges).toEqual([]);
  });

  it("leaves an explicit allow list untouched", () => {
    const raw = {
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
          modelPolicy: { allow: ["anthropic/*"] },
        },
      },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw.agents.defaults.modelPolicy.allow).toEqual(["anthropic/*"]);
    expect(changes).toEqual([]);
  });

  it("migrates only the default restriction and keeps per-agent metadata policy-free", () => {
    const raw = {
      agents: {
        defaults: { models: { "openai/*": {} } },
        list: [
          {
            id: "worker",
            models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
          },
        ],
      },
    };
    const changes: string[] = [];
    const createPolicy = (cfg: OpenClawConfig) =>
      createModelVisibilityPolicy({
        cfg,
        catalog: [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
        ],
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        agentId: "worker",
      });
    const before = createPolicy(raw);

    migration?.apply(raw, changes);

    expect(raw.agents.defaults).toMatchObject({ modelPolicy: { allow: ["openai/*"] } });
    expect(raw.agents.list[0]).not.toHaveProperty("modelPolicy");
    expect(raw).toMatchObject({
      meta: { migrations: { modelPolicyAllowlist: true } },
    });
    expect(changes).toHaveLength(1);
    const after = createPolicy(raw);
    expect(after.exactModelRefs).toEqual(before.exactModelRefs);
    expect([...after.providerWildcards]).toEqual([...before.providerWildcards]);
    expect(after.allowAny).toBe(before.allowAny);
    expect(after.allows({ provider: "openai", model: "gpt-5.5" })).toBe(
      before.allows({ provider: "openai", model: "gpt-5.5" }),
    );
  });

  it("ignores a per-agent model map when no legacy default restriction exists", () => {
    const raw = {
      agents: {
        list: [
          {
            id: "worker",
            models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
          },
        ],
      },
    };
    const changes: string[] = [];

    expect(migration?.legacyRules).toHaveLength(1);
    migration?.apply(raw, changes);

    expect(raw.agents.list[0]).not.toHaveProperty("modelPolicy");
    expect(raw).not.toHaveProperty("meta");
    expect(changes).toEqual([]);
  });

  it("marks a blank-only legacy map migrated without stamping an allow list", () => {
    const raw = { agents: { defaults: { models: { " ": {} } } } };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw.agents.defaults).not.toHaveProperty("modelPolicy");
    expect(raw).toMatchObject({
      meta: { migrations: { modelPolicyAllowlist: true } },
    });
    expect(changes).toHaveLength(1);

    const secondChanges: string[] = [];
    migration?.apply(raw, secondChanges);
    expect(secondChanges).toEqual([]);
  });
});

describe("legacy Codex policy wildcard migration", () => {
  const providerMigration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (entry) => entry.id === "models.providers.codex-routes->models.providers.openai",
  );

  it.each([
    {
      name: "default policy",
      agents: { defaults: { modelPolicy: { allow: ["codex/*"] } } },
      expectedPath: "agents.defaults.modelPolicy.allow.0",
    },
    {
      name: "per-agent policy",
      agents: {
        defaults: {},
        list: [{ id: "worker", modelPolicy: { allow: ["codex/*"] } }],
      },
      expectedPath: "agents.list.0.modelPolicy.allow.0",
    },
  ])("retains the legacy provider for a $name", ({ agents, expectedPath }) => {
    const raw = {
      agents,
      models: {
        providers: {
          codex: {
            api: "openai-chatgpt-responses",
            models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }],
          },
        },
      },
    } as Record<string, unknown>;
    const changes: string[] = [];

    providerMigration?.apply(raw, changes);

    const providers = (raw.models as { providers: Record<string, unknown> }).providers;
    expect(providers).toHaveProperty("codex");
    expect(providers).not.toHaveProperty("openai");
    expect(changes).toEqual([]);
    const blocked = collectBlockedLegacyOpenAICodexProviderPlan(raw);
    expect(blocked.blockedModelIdentities).toContain(
      expectDefined(legacyCodexProviderIdentityKey("codex"), "Codex identity test invariant"),
    );
    expect(blocked.warning).toContain(expectedPath);
    expect(blocked.warning).toContain("authorize unrelated OpenAI models");
  });
});

describe("stale contextWindow migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (m) => m.id === "models.providers.*.models.*.contextWindow-stale",
  );

  it("repairs deepseek-v4-flash contextWindow from 200K to 1M", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.deepseek.models[0],
        "raw.models.providers.deepseek.models[0] test invariant",
      ).contextWindow,
    ).toBe(1_000_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("200000 → 1000000");
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("repairs Grok 4.20 canonical and shipped alias context windows from 2M to 1M", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          xai: {
            models: [
              { id: "grok-4.20-0309-reasoning", contextWindow: 2_000_000 },
              { id: "grok-4.20-beta-latest-non-reasoning", contextWindow: 2_000_000 },
            ],
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(true);
    migration!.apply(raw, changes);

    expect(raw.models.providers.xai.models.map((model) => model.contextWindow)).toEqual([
      1_000_000, 1_000_000,
    ]);
    expect(changes).toHaveLength(2);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("does not modify correct contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 1_000_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.deepseek.models[0],
        "raw.models.providers.deepseek.models[0] test invariant",
      ).contextWindow,
    ).toBe(1_000_000);
    expect(changes).toHaveLength(0);
  });

  it("preserves non-stale custom contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 500_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.deepseek.models[0],
        "raw.models.providers.deepseek.models[0] test invariant",
      ).contextWindow,
    ).toBe(500_000);
    expect(changes).toHaveLength(0);
  });

  it("does not modify bare ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.custom.models[0],
        "raw.models.providers.custom.models[0] test invariant",
      ).contextWindow,
    ).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("handles provider-prefixed model IDs under the native provider", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.deepseek.models[0],
        "raw.models.providers.deepseek.models[0] test invariant",
      ).contextWindow,
    ).toBe(1_000_000);
    expect(changes).toHaveLength(1);
  });

  it("does not modify provider-prefixed ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openrouter: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.openrouter.models[0],
        "raw.models.providers.openrouter.models[0] test invariant",
      ).contextWindow,
    ).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("skips models not in the stale fixes registry", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-4o",
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(
      expectDefined(
        raw.models.providers.openai.models[0],
        "raw.models.providers.openai.models[0] test invariant",
      ).contextWindow,
    ).toBe(128_000);
    expect(changes).toHaveLength(0);
  });

  it("handles missing providers gracefully", () => {
    const changes: string[] = [];
    const raw = {};

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles non-array models gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: "not-an-array",
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles missing model id gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                contextWindow: 200_000,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });
});
