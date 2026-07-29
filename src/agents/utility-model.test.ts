// Utility-model resolution tests cover explicit/disabled/auto settings and
// provider-declared default derivation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { readUtilityModelSetting, resolveUtilityModelRefForAgent } from "./utility-model.js";

function snapshotWithDefaults(defaults: Record<string, string>): PluginMetadataSnapshot {
  const plugins = Object.entries(defaults).map(([provider, defaultUtilityModel], index) => ({
    id: `plugin-${index}`,
    modelCatalog: {
      providers: {
        [provider]: { defaultUtilityModel, models: [{ id: defaultUtilityModel }] },
      },
    },
  }));
  return { plugins } as unknown as PluginMetadataSnapshot;
}

describe("readUtilityModelSetting", () => {
  it("distinguishes unset, explicit, and empty-string disable", () => {
    expect(readUtilityModelSetting({} as OpenClawConfig, "main")).toEqual({ kind: "auto" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: " openai/gpt-5.4-mini " } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "explicit", modelRef: "openai/gpt-5.4-mini" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: "" } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: "   " } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "disabled" });
  });

  it("lets an agent-level empty string disable a defaults-level model", () => {
    const cfg = {
      agents: {
        defaults: { utilityModel: "openai/gpt-5.4-mini" },
        list: [{ id: "ops", utilityModel: "" }],
      },
    } as OpenClawConfig;

    expect(readUtilityModelSetting(cfg, "ops")).toEqual({ kind: "disabled" });
    expect(readUtilityModelSetting(cfg, "main")).toEqual({
      kind: "explicit",
      modelRef: "openai/gpt-5.4-mini",
    });
  });
});

describe("resolveUtilityModelRefForAgent", () => {
  const metadataSnapshot = snapshotWithDefaults({
    openai: "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
  });

  it("passes explicit config through untouched", () => {
    const cfg = {
      agents: { defaults: { utilityModel: "openrouter/mistralai/mistral-small" } },
    } as OpenClawConfig;

    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
      "openrouter/mistralai/mistral-small",
    );
  });

  it("returns undefined when utility routing is disabled", () => {
    const cfg = { agents: { defaults: { utilityModel: "" } } } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot }),
    ).toBeUndefined();
  });

  it("derives the provider default from the agent's primary model", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-fable-5" } },
    } as OpenClawConfig;

    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("carries the primary model's auth profile onto the derived default", () => {
    const cfg = {
      agents: { defaults: { model: "openai/gpt-5.5@work" } },
    } as OpenClawConfig;

    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
      "openai/gpt-5.6-luna@work",
    );
  });

  it("prefers caller-resolved session provider and profile context", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-fable-5@personal" } },
    } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({
        cfg,
        agentId: "main",
        primaryProvider: "OpenAI",
        primaryModelRef: "openai/gpt-5.5@work",
        metadataSnapshot,
      }),
    ).toBe("openai/gpt-5.6-luna@work");
  });

  it("returns undefined for providers without a declared default", () => {
    const cfg = {
      agents: { defaults: { model: "ollama/llama-4-70b" } },
    } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot }),
    ).toBeUndefined();
  });
});
