// Xai tests cover plugin-owned doctor compatibility migrations.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("xAI doctor contract", () => {
  it("detects and migrates retired server-tool defaults without changing other settings", () => {
    const config = {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: { model: "grok-4-1-fast", timeoutSeconds: 60 },
              xSearch: { model: "grok-4-1-fast-non-reasoning", inlineCitations: true },
              codeExecution: { model: "grok-code-fast-1", maxTurns: 2 },
            },
          },
        },
      },
      tools: {
        web: {
          search: { grok: { model: "grok-4-0709", baseUrl: "https://api.x.ai/v1" } },
          x_search: { model: "grok-3", enabled: true },
        },
      },
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            api: "openai-responses",
            models: [
              {
                id: "grok-4-1-fast",
                name: "Grok 4.1 Fast",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
                contextWindow: 2_000_000,
                maxTokens: 30_000,
              },
              {
                id: "grok-3-mini",
                name: "Custom Grok 3 Mini",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 },
                contextWindow: 131_072,
                maxTokens: 8_192,
              },
              { id: "grok-4.20-beta-latest-reasoning", name: "moving alias" },
              { id: "custom-model", name: "custom" },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      legacyConfigRules.filter((rule) => rule.match(readPathForTest(config, rule.path))),
    ).toHaveLength(4);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toHaveLength(4);
    expect(result.config).not.toBe(config);
    expect(result.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: { model: "grok-4.3", timeoutSeconds: 60 },
      xSearch: { model: "grok-4.3", inlineCitations: true },
      codeExecution: { model: "grok-build-0.1", maxTurns: 2 },
    });
    expect(result.config.tools?.web).toEqual(config.tools?.web);
    expect(result.config.models?.providers?.xai?.models).toEqual([
      {
        id: "grok-3-mini",
        name: "Custom Grok 3 Mini",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 8_192,
      },
      { id: "grok-4.20-beta-latest-reasoning", name: "moving alias" },
      { id: "custom-model", name: "custom" },
    ]);
    expect(config.plugins?.entries?.xai?.config).toMatchObject({
      webSearch: { model: "grok-4-1-fast" },
    });
    expect(config.models?.providers?.xai?.models).toHaveLength(4);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("leaves active aliases and intentional cross-mode choices unchanged", () => {
    const config = {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: { model: "grok-4.20-beta-latest-reasoning" },
              xSearch: { model: "grok-4-1-fast" },
              codeExecution: { model: "grok-4-fast-non-reasoning" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });
});

function readPathForTest(root: unknown, path: readonly (string | number)[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}
