import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import { parseModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import { createEmptyPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("llm-task doctor contract", () => {
  it("surfaces pre-policy entries and converges after migration", () => {
    const rule = legacyConfigRules.find(
      (candidate) => candidate.path.join(".") === "plugins.entries.llm-task",
    ) as { match?: (value: unknown, root: Record<string, unknown>) => boolean } | undefined;
    expect(rule?.match?.({ enabled: true }, {})).toBe(true);
    expect(
      rule?.match?.({ llm: { allowModelOverride: true, allowAuthProfileOverride: true } }, {}),
    ).toBe(false);
    expect(
      rule?.match?.({ llm: { allowModelOverride: false, allowAuthProfileOverride: false } }, {}),
    ).toBe(false);
  });

  it("moves shipped model policy and grants the shipped override capabilities", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": {
              enabled: true,
              config: {
                defaultModel: "gpt-5.6-sol",
                allowedModels: ["openai/gpt-5.6-sol"],
              },
            },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]).toEqual({
      enabled: true,
      llm: {
        allowModelOverride: true,
        allowAuthProfileOverride: true,
        allowedCompletionModels: ["openai/gpt-5.6-sol"],
      },
      config: { defaultModel: "gpt-5.6-sol" },
    });
    expect(result.changes).toHaveLength(2);
  });

  it("keeps literal migration policy independent of executable provider normalization", () => {
    const registry = createEmptyPluginRegistry();
    const normalizeModelId = vi.fn(() => "rewritten");
    registry.providers.push({
      pluginId: "doctor-policy-fixture",
      source: import.meta.url,
      provider: {
        id: "doctor-policy-fixture",
        label: "Doctor policy fixture",
        auth: [],
        normalizeModelId,
      },
    });
    withPluginRuntimeRegistryScope(registry, () => {
      expect(
        parseModelRef("doctor-policy-fixture/literal", "", {
          allowManifestNormalization: false,
        }),
      ).toEqual({ provider: "doctor-policy-fixture", model: "rewritten" });
      expect(normalizeModelId).toHaveBeenCalledOnce();
      normalizeModelId.mockClear();

      const result = normalizeCompatibilityConfig({
        cfg: {
          plugins: {
            entries: {
              "llm-task": {
                config: { allowedModels: ["doctor-policy-fixture/literal"] },
              },
            },
          },
        },
      });

      expect(normalizeModelId).not.toHaveBeenCalled();
      expect(result.config.plugins?.entries?.["llm-task"]?.llm?.allowedCompletionModels).toEqual([
        "doctor-policy-fixture/literal",
      ]);
    });
  });

  it("keeps shipped override policy and migrates legacy completion policy separately", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": {
              llm: {
                allowModelOverride: false,
                allowAuthProfileOverride: false,
                allowedModels: ["anthropic/claude-haiku-4-5"],
              },
              config: { allowedModels: ["openai/gpt-5.6-sol"] },
            },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]).toEqual({
      llm: {
        allowModelOverride: false,
        allowAuthProfileOverride: false,
        allowedModels: ["anthropic/claude-haiku-4-5"],
        allowedCompletionModels: ["openai/gpt-5.6-sol"],
      },
      config: {},
    });
    expect(result.changes).toEqual([
      "Moved plugins.entries.llm-task.config.allowedModels to plugins.entries.llm-task.llm.allowedCompletionModels.",
    ]);
  });

  it("keeps an explicit completion policy authoritative over the legacy key", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": {
              llm: {
                allowModelOverride: true,
                allowAuthProfileOverride: true,
                allowedCompletionModels: ["anthropic/claude-haiku-4-5"],
              },
              config: { allowedModels: ["openai/gpt-5.6-sol"] },
            },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]?.llm?.allowedCompletionModels).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
    expect(result.changes).toEqual([
      "Removed plugins.entries.llm-task.config.allowedModels; existing plugins.entries.llm-task.llm.allowedCompletionModels remains authoritative.",
    ]);
  });

  it("preserves the unrestricted meaning of an empty legacy allowlist", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": {
              enabled: true,
              config: { allowedModels: [] },
            },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]?.llm).toEqual({
      allowModelOverride: true,
      allowAuthProfileOverride: true,
    });
    expect(result.changes).toContain(
      "Removed empty plugins.entries.llm-task.config.allowedModels; unrestricted model selection remains unchanged.",
    );
  });

  it("does not give legacy literal wildcards or noncanonical refs new meaning", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": {
              config: {
                allowedModels: ["*", " openai/gpt-5.4 ", "OpenAI/gpt-5.5", "openai/gpt-5.6"],
              },
            },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]?.llm?.allowedCompletionModels).toEqual([
      "openai/gpt-5.6",
    ]);
  });

  it("keeps a nonempty legacy wildcard-only allowlist fail closed", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        plugins: {
          entries: {
            "llm-task": { config: { allowedModels: ["*"] } },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.["llm-task"]?.llm?.allowedCompletionModels).toEqual([]);
  });

  it.each(["openai/gpt-5.6", null, [123, null]])(
    "keeps malformed legacy allowlist %j fail closed",
    (allowedModels) => {
      const result = normalizeCompatibilityConfig({
        cfg: {
          plugins: {
            entries: {
              "llm-task": { config: { allowedModels } },
            },
          },
        },
      });

      expect(result.config.plugins?.entries?.["llm-task"]?.llm?.allowedCompletionModels).toEqual(
        [],
      );
    },
  );

  it("is idempotent after migration", () => {
    const cfg = {
      plugins: {
        entries: {
          "llm-task": {
            llm: { allowModelOverride: true, allowAuthProfileOverride: true },
            config: {},
          },
        },
      },
    } as const;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
