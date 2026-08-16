import { describe, expect, it } from "vitest";
import { resolveContextTokensForModelFromCache } from "../agents/context-resolution.js";
import { migrateLegacyContextBudgetConfig } from "./legacy.context-budget.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const noCachedValue = () => undefined;

describe("legacy context-budget config migration", () => {
  it("bakes provider defaults into explicit models without overwriting model values", () => {
    const raw = {
      models: {
        providers: {
          example: {
            contextTokens: 32_000,
            contextWindow: 64_000,
            models: [
              { id: "default", name: "Default" },
              { id: "custom", name: "Custom", contextTokens: 8_000, contextWindow: 16_000 },
            ],
          },
        },
      },
    };

    const migrated = migrateLegacyContextBudgetConfig(raw);
    const config = migrated.config as OpenClawConfig;
    const provider = config.models?.providers?.example;
    const beforeBudget = resolveContextTokensForModelFromCache(
      { provider: "example", model: "default", modelContextTokens: 32_000 },
      noCachedValue,
      noCachedValue,
    );
    const afterBudget = resolveContextTokensForModelFromCache(
      { cfg: config, provider: "example", model: "default" },
      noCachedValue,
      noCachedValue,
    );

    expect(afterBudget).toBe(beforeBudget);
    expect(provider).not.toHaveProperty("contextTokens");
    expect(provider).not.toHaveProperty("contextWindow");
    expect(provider?.models).toMatchObject([
      { contextTokens: 32_000, contextWindow: 64_000 },
      { contextTokens: 8_000, contextWindow: 16_000 },
    ]);
    expect(migrated.changes).toEqual([
      "models.providers.example.contextTokens → models.providers.example.models[0].contextTokens.",
      "Removed models.providers.example.contextTokens after baking it into explicit model entries.",
      "models.providers.example.contextWindow → models.providers.example.models[0].contextWindow.",
      "Removed models.providers.example.contextWindow after baking it into explicit model entries.",
    ]);
    expect(migrated.warnings).toEqual([]);
  });

  it("removes provider defaults without model entries and names the replacement", () => {
    const migrated = migrateLegacyContextBudgetConfig({
      models: { providers: { example: { contextTokens: 32_000, contextWindow: 64_000 } } },
    });

    expect(migrated.config).toEqual({ models: { providers: { example: {} } } });
    expect(migrated.changes).toEqual([
      "Removed models.providers.example.contextTokens.",
      "Removed models.providers.example.contextWindow.",
    ]);
    expect(migrated.warnings).toEqual([
      "models.providers.example.contextTokens had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.",
      "models.providers.example.contextWindow had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.",
    ]);
  });

  it("removes every agent-level cap surface and is idempotent", () => {
    const raw = {
      agents: {
        defaults: { contextTokens: 128_000 },
        entries: { ops: { contextTokens: 64_000 }, writer: {} },
        list: [{ id: "legacy", contextTokens: 32_000 }],
      },
    };

    const migrated = migrateLegacyContextBudgetConfig(raw);

    expect(migrated.config).toEqual({
      agents: { defaults: {}, entries: { ops: {}, writer: {} }, list: [{ id: "legacy" }] },
    });
    expect(migrated.changes).toEqual([
      "Removed agents.defaults.contextTokens.",
      "Removed agents.entries.ops.contextTokens.",
      "Removed agents.list[0].contextTokens.",
    ]);
    expect(migrated.warnings).toHaveLength(3);
    expect(migrateLegacyContextBudgetConfig(migrated.config)).toEqual({
      config: migrated.config,
      changed: false,
      changes: [],
      warnings: [],
    });
    expect(raw.agents.defaults).toHaveProperty("contextTokens", 128_000);
  });

  it("returns the original canonical config without cloning or changes", () => {
    const canonical = {
      models: { providers: { example: { models: [{ id: "model", contextTokens: 16_000 }] } } },
    };

    const migrated = migrateLegacyContextBudgetConfig(canonical);

    expect(migrated.config).toBe(canonical);
    expect(migrated).toEqual({ config: canonical, changed: false, changes: [], warnings: [] });
  });
});
