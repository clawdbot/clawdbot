// Configured model list tests cover listing models from configured providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatModelRefForConfig } from "../../agents/model-selection-shared.js";

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "models-list-configured-test-empty-plugin-metadata",
  plugins: [],
}));

const mocks = vi.hoisted(() => ({
  loadPreparedModelCatalogSnapshot: vi.fn(),
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: vi.fn(() => {
    throw new Error("runtime model normalization should not load for models list entries");
  }),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: mocks.loadPreparedModelCatalogSnapshot,
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModelCore: vi.fn(() => false),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

import { resolveConfiguredEntries } from "./list.configured.js";
import { appendConfiguredModelRowSources } from "./list.row-sources.js";
import type { ModelRow } from "./list.types.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveConfiguredEntries", () => {
  it("parses configured models without loading provider-runtime normalization", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5", fallbacks: ["codex/gpt-5.4-mini"] },
          models: {
            "codex/gpt-5.5": { alias: "Codex" },
            "codex/gpt-5.4-mini": {},
          },
        },
      },
      models: { providers: {} },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["codex/gpt-5.5", "codex/gpt-5.4-mini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
    expect(entries[0]?.aliases).toEqual(["Codex"]);
    expect(entries[1]?.tags).toEqual(new Set(["fallback#1", "configured"]));
  });

  it("normalizes retired nested Gemini ids in configured provider rows", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "kilocode/google/gemini-3-pro-preview" },
          models: {
            "kilocode/google/gemini-3-pro-preview": { alias: "Kilo Gemini" },
          },
        },
      },
      models: {
        providers: {
          kilocode: {
            api: "openai-completions",
            baseUrl: "https://kilocode.test/v1",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["kilocode/google/gemini-3.1-pro-preview"]);
    expect(entries[0]?.aliases).toEqual(["Kilo Gemini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });
  it("treats provider wildcard defaults as selectors, not configured model rows", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/*": {},
            "openai/gpt-5.5": { alias: "Primary" },
          },
        },
      },
      models: { providers: {} },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["openai/gpt-5.5"]);
    expect(entries[0]?.aliases).toEqual(["Primary"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });

  it("canonicalizes manifest-owned provider aliases in configured rows", () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));

    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "z.ai/glm-4.7" },
          models: {
            "z.ai/glm-4.7": { alias: "GLM" },
          },
        },
      },
      models: { providers: {} },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["zai/glm-4.7"]);
    expect(entries[0]?.aliases).toEqual(["GLM"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });

  it("recovers bundled source aliases when stale dist metadata omits them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-alias-source-"));
    try {
      const distPluginRoot = path.join(root, "dist", "extensions", "zai");
      const sourcePluginRoot = path.join(root, "extensions", "zai");
      fs.mkdirSync(distPluginRoot, { recursive: true });
      fs.mkdirSync(sourcePluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourcePluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "zai",
          configSchema: { type: "object" },
          providers: ["zai"],
          modelCatalog: {
            aliases: {
              "z.ai": { provider: "zai" },
            },
          },
        }),
        "utf8",
      );

      const { entries } = resolveConfiguredEntries(
        {
          agents: {
            defaults: {
              model: { primary: "z.ai/glm-4.7" },
            },
          },
          models: { providers: {} },
        },
        {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              {
                id: "zai",
                origin: "bundled",
                rootDir: distPluginRoot,
                source: path.join(distPluginRoot, "index.js"),
                providers: ["zai"],
                channels: [],
                cliBackends: [],
                skills: [],
                hooks: [],
                modelCatalog: { providers: {}, discovery: { zai: "static" } },
                manifestPath: path.join(distPluginRoot, "openclaw.plugin.json"),
              },
            ],
          },
        },
      );

      expect(entries.map((entry) => entry.key)).toEqual(["zai/glm-4.7"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("configured model list rows", () => {
  it("keeps raw alias auth for self-prefixed implicit models in replace mode", async () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    const catalogEntry = {
      id: "glm-4.7",
      name: "GLM 4.7",
      provider: "zai",
      input: ["text"] as const,
      contextWindow: 128_000,
    };
    mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [catalogEntry],
      routeVariants: [catalogEntry],
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "z.ai/glm-4.7", fallbacks: ["google/gemini-stale"] },
          models: { "openai/gpt-stale": {} },
        },
      },
      models: {
        mode: "replace" as const,
        providers: {
          "z.ai": {
            baseUrl: "https://api.z.ai/v1",
            models: [
              {
                id: "z.ai/glm-4.7",
                name: "GLM 4.7",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
              {
                id: "z.ai/glm-4.8",
                name: "GLM 4.8",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };
    const { entries } = resolveConfiguredEntries(cfg);
    const evaluateModelAuth = vi.fn((provider: string) => ({
      availability: provider === "z.ai",
      routeResolution: null,
    }));
    const rows: ModelRow[] = [];

    await appendConfiguredModelRowSources({
      rows,
      entries,
      context: {
        cfg,
        formatModelRef: (ref) => formatModelRefForConfig(ref, { cfg, manifestPlugins: [] }),
        agentDir: "/tmp/openclaw-agent",
        authIndex: { evaluateModelAuth },
        canonicalizeProvider: createModelCatalogProviderAliasCanonicalizer({ cfg }).provider,
        configuredByKey: new Map(entries.map((entry) => [entry.key, entry])),
        discoveredKeys: new Set(),
        filter: {},
      },
    });

    expect(rows.map((row) => row.key)).toEqual(["zai/z.ai/glm-4.7", "zai/z.ai/glm-4.8"]);
    expect(rows[0]).toMatchObject({ name: "GLM 4.7", available: true });
    expect(rows[1]).toMatchObject({ name: "GLM 4.8", available: true });
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(evaluateModelAuth).toHaveBeenCalledWith(
      "z.ai",
      expect.objectContaining({ modelId: "z.ai/glm-4.7" }),
    );
    expect(evaluateModelAuth).toHaveBeenCalledWith(
      "z.ai",
      expect.objectContaining({ modelId: "z.ai/glm-4.8" }),
    );
  });

  it("drops a stale default outside models.providers in replace mode", async () => {
    const cfg = {
      agents: { defaults: { model: { primary: "google/gemini-stale" } } },
      models: {
        mode: "replace" as const,
        providers: {
          xiaomi: {
            baseUrl: "https://api.xiaomi.example/v1",
            models: [
              {
                id: "mimo-v2.5",
                name: "MiMo V2.5",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };
    const { entries } = resolveConfiguredEntries(cfg);
    const rows: ModelRow[] = [];

    await appendConfiguredModelRowSources({
      rows,
      entries,
      context: {
        cfg,
        formatModelRef: (ref) => formatModelRefForConfig(ref, { cfg, manifestPlugins: [] }),
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({ availability: true, routeResolution: null }),
        },
        canonicalizeProvider: createModelCatalogProviderAliasCanonicalizer({ cfg }).provider,
        configuredByKey: new Map(entries.map((entry) => [entry.key, entry])),
        discoveredKeys: new Set(),
        filter: {},
      },
    });

    expect(rows).toMatchObject([
      { key: "xiaomi/mimo-v2.5", name: "MiMo V2.5", tags: [], available: true },
    ]);
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("renders plugin-catalog metadata for a fallback ref instead of default placeholders", async () => {
    const catalogEntry = {
      id: "k3",
      name: "Kimi K3",
      provider: "kimi",
      api: "openai-completions" as const,
      baseUrl: "https://api.moonshot.ai/v1",
      contextWindow: 1_048_576,
      input: ["text", "image"] as const,
    };
    // Conflicting catalog metadata for an explicitly configured provider model:
    // the user's models.providers definition must win over the catalog row.
    const conflictingCatalogEntry = {
      id: "own-model",
      name: "Catalog Own Model",
      provider: "custom",
      contextWindow: 999_999,
      input: ["text", "image"] as const,
    };
    mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [catalogEntry, conflictingCatalogEntry],
      routeVariants: [catalogEntry, conflictingCatalogEntry],
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-for-coding", fallbacks: ["kimi/k3", "custom/own-model"] },
        },
      },
      models: {
        providers: {
          custom: {
            api: "openai-completions" as const,
            baseUrl: "https://custom.test/v1",
            models: [
              {
                id: "own-model",
                name: "Own Model",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 8_000,
              },
            ],
          },
        },
      },
    };
    const { entries } = resolveConfiguredEntries(cfg);
    const rows: ModelRow[] = [];

    await appendConfiguredModelRowSources({
      rows,
      entries,
      context: {
        cfg,
        formatModelRef: (ref) => formatModelRefForConfig(ref, { cfg, manifestPlugins: [] }),
        agentDir: "/tmp/openclaw-agent",
        authIndex: { evaluateModelAuth: () => ({ availability: true, routeResolution: null }) },
        canonicalizeProvider: createModelCatalogProviderAliasCanonicalizer({ cfg }).provider,
        configuredByKey: new Map(entries.map((entry) => [entry.key, entry])),
        discoveredKeys: new Set<string>(),
        filter: {},
      },
    });

    const fallbackRow = rows.find((row) => row.key === "kimi/k3");
    expect(fallbackRow).toMatchObject({
      name: "Kimi K3",
      input: "text+image",
      contextWindow: 1_048_576,
    });
    expect(fallbackRow?.tags).toContain("fallback#1");
    // Explicit models.providers metadata beats the conflicting catalog row.
    expect(rows.find((row) => row.key === "custom/own-model")).toMatchObject({
      name: "Own Model",
      input: "text",
      contextWindow: 32_000,
    });
    // Refs the catalog does not know still fall back to the default placeholder row.
    expect(rows.find((row) => row.key === "kimi/kimi-for-coding")).toMatchObject({
      input: "text",
      contextWindow: 200_000,
    });
    // The catalog is a single committed generation; configured and catalog rows share one load.
    expect(mocks.loadPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(1);
  });
});
