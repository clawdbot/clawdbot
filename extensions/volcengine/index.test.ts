import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS,
  resolveVolcengineToolSchemaCompatPatch,
} from "./api.js";
import plugin from "./index.js";
import { DOUBAO_CODING_MODEL_CATALOG, DOUBAO_MODEL_CATALOG } from "./models.js";

describe("volcengine plugin", () => {
  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [],
    } as never);

    expect(entries).toEqual([
      ...DOUBAO_MODEL_CATALOG.map((entry) => ({
        provider: "volcengine",
        id: entry.id,
        name: entry.name,
        reasoning: entry.reasoning,
        input: [...entry.input],
        contextWindow: entry.contextWindow,
      })),
      ...DOUBAO_CODING_MODEL_CATALOG.map((entry) => ({
        provider: "volcengine-plan",
        id: entry.id,
        name: entry.name,
        reasoning: entry.reasoning,
        input: [...entry.input],
        contextWindow: entry.contextWindow,
      })),
    ]);
  });

  it("declares its coding provider auth alias in the manifest", () => {
    const pluginJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
    );

    expect(pluginJson.providerAuthAliases).toEqual({
      "volcengine-plan": "volcengine",
    });
  });

  it("marks direct and coding models with tool schema keyword compat", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.hookAliases).toContain("volcengine-plan");
    expect(resolveVolcengineToolSchemaCompatPatch()).toEqual({
      unsupportedToolSchemaKeywords: [...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS],
    });

    const normalized = provider.normalizeResolvedModel?.({
      provider: "volcengine-plan",
      modelId: "kimi-k2.5",
      model: {
        id: "kimi-k2.5",
        provider: "volcengine-plan",
        api: "openai-completions",
        compat: { unsupportedToolSchemaKeywords: ["not"] },
      },
    } as never);

    const normalizedCompat = normalized?.compat as
      | { unsupportedToolSchemaKeywords?: string[] }
      | undefined;
    expect(normalizedCompat?.unsupportedToolSchemaKeywords).toEqual([
      "not",
      ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS,
    ]);
  });
});
