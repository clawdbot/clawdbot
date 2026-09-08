// Checks model reference normalization across manifests and runtime owners.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
});

describe("normalizeStaticProviderModelId", () => {
  it("re-adds the nvidia prefix for bare model ids", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix already prefixed models", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("applies shipped bundled provider model aliases without manifest lookup", () => {
    // Shipped aliases must work before plugin metadata is loaded so catalog and
    // config parsing can normalize common refs during startup.
    expect(normalizeStaticProviderModelId("anthropic", "sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(normalizeStaticProviderModelId("vercel-ai-gateway", "sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(normalizeStaticProviderModelId("huggingface", "huggingface/vendor/model")).toBe(
      "vendor/model",
    );
  });

  it("strips native Anthropic provider prefixes from static catalog ids", () => {
    expect(normalizeStaticProviderModelId("anthropic", "anthropic/claude-haiku-4-5")).toBe(
      "claude-haiku-4-5",
    );
  });

  it("uses supplied manifest normalization policies when provided", () => {
    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: {
            custom: {
              prefixWhenBare: "vendor",
            },
          },
        },
      },
    ];

    expect(normalizeStaticProviderModelId("custom", "model", { manifestPlugins })).toBe(
      "vendor/model",
    );
  });

  it("keeps OpenRouter bare compatibility ids provider-qualified without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("openrouter", "auto", {
        allowManifestNormalization: false,
      }),
    ).toBe("openrouter/auto");
  });

  it("preserves provider-owned XAI beta aliases without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("xai", "grok-4.20-experimental-beta-0304-reasoning", {
        allowManifestNormalization: false,
      }),
    ).toBe("grok-4.20-experimental-beta-0304-reasoning");
  });

  it("normalizes the shipped retired Together default without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("together", "moonshotai/Kimi-K2.5", {
        allowManifestNormalization: false,
      }),
    ).toBe("moonshotai/Kimi-K2.6");
  });

  it("uses current plugin metadata manifest normalization by default", () => {
    // Runtime callers use the current metadata snapshot by default, so plugin
    // normalization policy applies even without an explicit manifest list.
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { aliases: { latest: "custom/modern-model" } },
              },
            },
          },
        ],
      }),
      { config: {} },
    );

    expect(normalizeStaticProviderModelId("custom", "latest")).toBe("custom/modern-model");
  });
});

describe("normalizeConfiguredProviderCatalogModelId", () => {
  const manifestPlugins = [
    {
      modelIdNormalization: {
        providers: {
          custom: {
            aliases: {
              latest: "modern-model",
            },
            prefixWhenBare: "vendor",
          },
        },
      },
    },
  ];

  it("applies supplied manifest normalization policies to configured catalog ids", () => {
    expect(normalizeConfiguredProviderCatalogModelId("custom", "latest", { manifestPlugins })).toBe(
      "vendor/modern-model",
    );
  });

  it("can skip manifest normalization while retaining built-in normalization", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("custom", "latest", {
        allowManifestNormalization: false,
        manifestPlugins,
      }),
    ).toBe("latest");
  });

  it("normalizes nested retired Google Gemini ids in proxy-prefixed rows", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("kilocode", "kilocode/google/gemini-3-pro-preview"),
    ).toBe("kilocode/google/gemini-3.1-pro-preview");
  });
});

const execFileAsync = promisify(execFile);

function createModelNormalizerGeneration() {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "foreign-owner",
    source: "foreign-owner.ts",
    provider: {
      id: "foreign",
      hookAliases: ["fixture"],
      label: "Foreign alias",
      auth: [],
      normalizeModelId: () => "foreign-model",
    },
  });
  pluginRegistry.providers.push({
    pluginId: "fixture-owner",
    source: "fixture-owner.ts",
    provider: {
      id: "fixture",
      hookAliases: ["fixture-alias"],
      label: "Fixture",
      auth: [],
      normalizeModelId(this: ProviderPlugin, { modelId }) {
        return `${this.pluginId}-${modelId}`;
      },
    },
  });
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "foreign-owner", providers: ["foreign"] },
      { id: "fixture-owner", providers: ["fixture"] },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}

describe("provider model normalization bridge", () => {
  it.each(
    ["fixture", "fixture-alias"].flatMap((provider) =>
      ["generation", "request", "active"].map((scope) => ({ provider, scope })),
    ),
  )("invokes $provider with its registry owner from $scope", ({ provider, scope }) => {
    const generation = createModelNormalizerGeneration();
    const normalize = () =>
      normalizeProviderModelIdWithRuntime({
        provider,
        context: { provider, modelId: "model" },
      });
    if (scope === "active") {
      setActivePluginRegistry(generation.pluginRegistry, "normalizer-fixture");
    }
    const result =
      scope === "generation"
        ? withPluginRuntimeGenerationScope(generation, normalize)
        : scope === "request"
          ? withPluginRuntimeRegistryScope(generation.pluginRegistry, normalize)
          : normalize();
    expect(result).toBe("fixture-owner-model");
  });

  it("keeps an empty generation authoritative over ambient request hooks", () => {
    const generation = createModelNormalizerGeneration();
    expect(
      withPluginRuntimeRegistryScope(generation.pluginRegistry, () =>
        withPluginRuntimeGenerationScope(
          { ...generation, pluginRegistry: createEmptyPluginRegistry() },
          () =>
            normalizeProviderModelIdWithRuntime({
              provider: "fixture",
              context: { provider: "fixture", modelId: "model" },
            }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not borrow an active provider on a request registry miss", () => {
    const generation = createModelNormalizerGeneration();
    setActivePluginRegistry(generation.pluginRegistry, "another-gateway");
    const normalize = () =>
      normalizeProviderModelIdWithRuntime({
        provider: "fixture",
        context: { provider: "fixture", modelId: "model" },
      });
    expect(normalize()).toBe("fixture-owner-model");
    expect(withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), normalize)).toBeUndefined();
  });

  it("invokes the retained normalizer from the packaged runtime layout", async () => {
    await withTempDir("openclaw-model-normalizer-", async (root) => {
      const dist = path.join(root, "dist");
      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const bridgePath = path.join(dist, "model-reference.js");
      // The bundler places this bridge at the dist root, unlike its source directory.
      await build({
        entryPoints: [path.resolve("src/agents/provider-model-normalization.runtime.ts")],
        outfile: bridgePath,
        bundle: true,
        platform: "node",
        format: "esm",
        tsconfig: path.resolve("tsconfig.json"),
      });
      // SAFETY: This test emits the actual typed bridge into a standalone package.
      const bridge = createRequire(import.meta.url)(
        bridgePath,
      ) as typeof import("./provider-model-normalization.runtime.js");

      expect(
        withPluginRuntimeGenerationScope(createModelNormalizerGeneration(), () =>
          bridge.normalizeProviderModelIdWithRuntime({
            provider: "fixture",
            context: { provider: "fixture", modelId: "model" },
          }),
        ),
      ).toBe("fixture-owner-model");
    });
  });

  it("applies source manifest normalization once without an executable hook", async () => {
    await withTempDir("openclaw-model-normalizer-source-", async (root) => {
      // Native source execution protects the same contract before runtime preparation.
      const script = `
        const { pathToFileURL } = await import("node:url");
        const load = (file) => import(pathToFileURL(${JSON.stringify(process.cwd())} + "/" + file).href);
        const { normalizeModelRef } = await load("src/agents/model-ref-shared.ts");
        const { createPluginMetadataSnapshotFixture } = await load("src/plugins/plugin-metadata.test-support.ts");
        const { createEmptyPluginRegistry } = await load("src/plugins/registry-empty.ts");
        const { withPluginRuntimeGenerationScope } = await load("src/plugins/runtime/generation-scope.ts");
        const { withPluginRuntimeRegistryScope } = await load("src/plugins/runtime/gateway-request-scope.ts");
        const { withPluginMetadataSnapshotScope } = await load("src/plugins/current-plugin-metadata-snapshot.ts");
        const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{
          id: "fixture", providers: ["fixture"],
          modelIdNormalization: { providers: { fixture: { stripPrefixes: ["compat/"] } } },
        }] });
        const empty = withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
          () => normalizeModelRef("fixture", "compat/compat/model"),
        );
        const registry = createEmptyPluginRegistry();
        registry.providers.push({ pluginId: "fixture", provider: { id: "fixture", label: "Fixture", auth: [] } });
        const request = withPluginMetadataSnapshotScope(metadataSnapshot,
          () => withPluginRuntimeRegistryScope(registry,
            () => normalizeModelRef("fixture", "compat/compat/model")),
          { trustConfigIdentity: true });
        const unprepared = withPluginMetadataSnapshotScope(metadataSnapshot,
          () => normalizeModelRef("fixture", "compat/compat/model"),
          { trustConfigIdentity: true });
        process.stdout.write(JSON.stringify({ empty, request, unprepared }));
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "--eval", script],
        {
          env: {
            ...process.env,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        empty: { provider: "fixture", model: "compat/model" },
        request: { provider: "fixture", model: "compat/model" },
        unprepared: { provider: "fixture", model: "compat/model" },
      });
    });
  });
});
