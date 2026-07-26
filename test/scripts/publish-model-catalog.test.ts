import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleModelCatalogBundle,
  enrichModelCatalogPricing,
  LITELLM_PRICING_URL,
  MODEL_CATALOG_MIN_MODELS,
  OPENROUTER_MODELS_URL,
  parsePublishModelCatalogArgs,
  readModelCatalogManifests,
  serializeModelCatalogBundle,
  summarizeModelCatalogBundle,
} from "../../scripts/publish-model-catalog.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureProvider(
  prefix: string,
  count: number,
): {
  models: Array<{ id: string; cost?: { input: number; output: number } }>;
} {
  return { models: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` })) };
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function writeFixtureManifest(root: string, pluginId: string, providers: Record<string, unknown>) {
  const pluginDir = path.join(root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId, modelCatalog: { providers } }, null, 2)}\n`,
  );
}

describe("publish model catalog", () => {
  it("assembles and validates fixture manifests at the 200-model floor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-"));
    tempDirs.push(root);
    writeFixtureManifest(root, "anthropic", { anthropic: fixtureProvider("claude", 100) });
    writeFixtureManifest(root, "openai", { openai: fixtureProvider("gpt", 100) });

    const bundle = await assembleModelCatalogBundle({
      manifests: readModelCatalogManifests({ rootDir: root }),
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    expect(summarizeModelCatalogBundle(bundle)).toEqual({
      providers: 2,
      models: 200,
      costModels: 0,
      pricingEntries: 0,
    });
    expect(MODEL_CATALOG_MIN_MODELS).toBe(200);
  });

  it("rejects missing required providers, low counts, and invalid provider rows", async () => {
    const makeEntry = (providers: Record<string, unknown>) => [
      {
        pluginId: "fixture",
        manifestPath: "fixture.json",
        manifest: { modelCatalog: { providers } },
      },
    ];
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({ anthropic: fixtureProvider("claude", 200) }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("anthropic and openai");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: fixtureProvider("gpt", 99),
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("below required floor 200");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: { models: [{ id: "" }, ...fixtureProvider("gpt", 100).models] },
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow();
  });

  it("parses supported CLI arguments and rejects missing output", () => {
    expect(parsePublishModelCatalogArgs(["--dry-run", "--out", "ignored.json"])).toEqual({
      dryRun: true,
      pricing: false,
      out: "ignored.json",
    });
    expect(() => parsePublishModelCatalogArgs([])).toThrow("provide --out");
  });

  it("dry-runs the repository manifests without writing output", () => {
    const root = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-smoke-"));
    tempDirs.push(tempDir);
    const out = path.join(tempDir, "catalog.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/publish-model-catalog.mjs", "--dry-run", "--out", out],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const stats = /dry-run schemaVersion=1 providers=39 models=(\d+)/u.exec(result.stdout);
    expect(stats).not.toBeNull();
    expect(Number(stats?.[1])).toBeGreaterThanOrEqual(MODEL_CATALOG_MIN_MODELS);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("enriches catalog models and emits unmatched hosted pricing keys", async () => {
    const anthropic = fixtureProvider("claude", 100);
    anthropic.models[0] = { id: "claude-3-5-sonnet" };
    const openai = fixtureProvider("gpt", 100);
    openai.models[0] = { id: "gpt-special" };
    openai.models[1] = { id: "zero-upstream", cost: { input: 5, output: 6 } };
    const manifests = [
      {
        pluginId: "anthropic",
        manifestPath: "anthropic.json",
        manifest: {
          modelCatalog: { providers: { anthropic } },
          modelPricing: {
            providers: { anthropic: { openRouter: { modelIdTransforms: ["version-dots"] } } },
          },
        },
      },
      {
        pluginId: "openai",
        manifestPath: "openai.json",
        manifest: { modelCatalog: { providers: { openai } } },
      },
      {
        pluginId: "openrouter",
        manifestPath: "openrouter.json",
        manifest: {
          modelPricing: {
            providers: {
              openrouter: {
                openRouter: { passthroughProviderModel: true },
                liteLLM: false,
              },
            },
          },
        },
      },
      {
        pluginId: "mapped",
        manifestPath: "mapped.json",
        manifest: {
          modelPricing: {
            providers: {
              mapped: { openRouter: { provider: "approved-source" }, liteLLM: false },
            },
          },
        },
      },
    ];
    const bundle = await assembleModelCatalogBundle({
      manifests,
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    const fetchImpl = async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === OPENROUTER_MODELS_URL) {
        return Response.json({
          data: [
            {
              id: "anthropic/claude-3.5-sonnet",
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
            {
              id: "openai/gpt-special",
              pricing: { prompt: "0.000003", completion: "0.000004" },
            },
            { id: "openai/gpt-2", pricing: { prompt: "-1", completion: "0.000004" } },
            { id: "unknown/new-model", pricing: { prompt: "1", completion: "1" } },
            { id: "custom/secondary-wins", pricing: { prompt: "0", completion: "0" } },
            { id: "mapped/wrong-source", pricing: { prompt: "0.000013", completion: "0.000014" } },
          ],
        });
      }
      expect(url).toBe(LITELLM_PRICING_URL);
      return Response.json({
        "gpt-special": {
          litellm_provider: "openai",
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000004,
          tiered_pricing: [
            { input_cost_per_token: 0.000005, output_cost_per_token: 0.000006, range: [1000] },
          ],
        },
        "gpt-2": {
          litellm_provider: "openai",
          input_cost_per_token: -1,
          output_cost_per_token: 0.000004,
        },
        "unknown/new-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
        "external-model": {
          litellm_provider: "custom",
          input_cost_per_token: 0.000007,
          output_cost_per_token: 0.000008,
        },
        "forbidden-model": {
          litellm_provider: "openrouter",
          input_cost_per_token: 0.000009,
          output_cost_per_token: 0.00001,
        },
        "secondary-wins": {
          litellm_provider: "custom",
          input_cost_per_token: 0.000011,
          output_cost_per_token: 0.000012,
        },
        "zero-upstream": {
          litellm_provider: "openai",
          input_cost_per_token: 0,
          output_cost_per_token: 0,
        },
      });
    };

    await expect(enrichModelCatalogPricing({ bundle, manifests, fetchImpl })).resolves.toEqual({
      modelsEnriched: 2,
      pricingEntries: 11,
    });
    expect(bundle.providers.anthropic?.models[0]?.cost).toMatchObject({ input: 1, output: 2 });
    expect(bundle.providers.openai?.models[0]?.cost).toMatchObject({
      input: 3,
      output: 4,
      tieredPricing: [{ input: 5, output: 6, range: [1000] }],
    });
    expect(bundle.providers.openai?.models[1]?.cost).toEqual({ input: 5, output: 6 });
    expect(bundle.providers.openai?.models[2]?.cost).toBeUndefined();
    expect(bundle.pricing).toEqual({
      "anthropic/claude-3.5-sonnet": { input: 1, output: 2 },
      "custom/external-model": { input: 7, output: 8 },
      "custom/secondary-wins": { input: 11, output: 12 },
      "external-model": { input: 7, output: 8 },
      "forbidden-model": { input: 9, output: 10 },
      "openrouter/anthropic/claude-3.5-sonnet": { input: 1, output: 2 },
      "openrouter/mapped/wrong-source": { input: 13, output: 14 },
      "openrouter/openai/gpt-special": { input: 3, output: 4 },
      "openrouter/unknown/new-model": { input: 1_000_000, output: 1_000_000 },
      "secondary-wins": { input: 11, output: 12 },
      "unknown/new-model": { input: 1_000_000, output: 1_000_000 },
    });
    expect(bundle.pricing).not.toHaveProperty("openrouter/forbidden-model");
    expect(bundle.pricing).not.toHaveProperty("mapped/wrong-source");
    expect(bundle.pricing).not.toHaveProperty("gpt-special");
    expect(bundle.pricing).not.toHaveProperty("openai/gpt-special");
    expect(summarizeModelCatalogBundle(bundle)).toMatchObject({
      models: 200,
      costModels: 3,
      pricingEntries: 11,
    });
    expect(Object.hasOwn(bundle.providers, "unknown")).toBe(false);
  });

  it("fails soft when pricing sources are unreachable or malformed", async () => {
    const manifests = [
      {
        pluginId: "fixture",
        manifestPath: "fixture.json",
        manifest: {
          modelCatalog: {
            providers: {
              anthropic: fixtureProvider("claude", 100),
              openai: fixtureProvider("gpt", 100),
            },
          },
        },
      },
    ];
    const bundle = await assembleModelCatalogBundle({
      manifests,
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      warnings.push(String(value));
      return true;
    });
    try {
      await expect(
        enrichModelCatalogPricing({
          bundle,
          manifests,
          fetchImpl: async (input) => {
            if (requestUrl(input) === OPENROUTER_MODELS_URL) {
              throw new Error("offline");
            }
            return new Response("not-json", { status: 200 });
          },
        }),
      ).resolves.toEqual({ modelsEnriched: 0, pricingEntries: 0 });
    } finally {
      stderr.mockRestore();
    }
    expect(warnings.join("")).toContain("OpenRouter pricing unavailable");
    expect(warnings.join("")).toContain("LiteLLM pricing unavailable");
    expect(summarizeModelCatalogBundle(bundle).costModels).toBe(0);
  });

  it("serializes provider keys and model rows deterministically", () => {
    const base = {
      schemaVersion: 1,
      generatedAt: 1,
      minVersion: "2026.7.0",
      sourceCommit: "sha",
    } as const;
    const left = {
      ...base,
      providers: { zeta: { models: [{ id: "b" }, { id: "a" }] }, alpha: { models: [{ id: "c" }] } },
      pricing: { "z/model": { input: 2, output: 3 }, "a/model": { input: 1, output: 2 } },
    };
    const right = {
      ...base,
      providers: { alpha: { models: [{ id: "c" }] }, zeta: { models: [{ id: "a" }, { id: "b" }] } },
      pricing: { "a/model": { output: 2, input: 1 }, "z/model": { output: 3, input: 2 } },
    };
    expect(serializeModelCatalogBundle(left)).toBe(serializeModelCatalogBundle(right));
  });

  it("ends failures with the stable wrapper marker", () => {
    const result = spawnSync(process.execPath, ["scripts/publish-model-catalog.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[publish-model-catalog] FAILED (exit 1)");
  });
});
