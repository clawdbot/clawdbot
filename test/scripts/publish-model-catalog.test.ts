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

function fixtureProvider(prefix: string, count: number) {
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

  it("enriches only existing models with OpenRouter flat and LiteLLM tier pricing", async () => {
    const anthropic = fixtureProvider("claude", 100);
    anthropic.models[0] = { id: "claude-3-5-sonnet" };
    const openai = fixtureProvider("gpt", 100);
    openai.models[0] = { id: "gpt-special" };
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
      });
    };

    await expect(enrichModelCatalogPricing({ bundle, manifests, fetchImpl })).resolves.toBe(2);
    expect(bundle.providers.anthropic?.models[0]?.cost).toMatchObject({ input: 1, output: 2 });
    expect(bundle.providers.openai?.models[0]?.cost).toMatchObject({
      input: 3,
      output: 4,
      tieredPricing: [{ input: 5, output: 6, range: [1000] }],
    });
    expect(bundle.providers.openai?.models[2]?.cost).toBeUndefined();
    expect(summarizeModelCatalogBundle(bundle)).toMatchObject({ models: 200, costModels: 2 });
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
      ).resolves.toBe(0);
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
    };
    const right = {
      ...base,
      providers: { alpha: { models: [{ id: "c" }] }, zeta: { models: [{ id: "a" }, { id: "b" }] } },
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
