// Coverage for resolving bundled static manifest model catalog rows.
import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));
const providerMocks = vi.hoisted(() => ({
  normalizePluginDiscoveryResult: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProviderRef: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistry: manifestMocks.loadPluginManifestRegistry,
}));

vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveActivatableProviderOwnerPluginIds: providerMocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: providerMocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: providerMocks.resolveOwningPluginIdsForProviderRef,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-discovery.js")>()),
  normalizePluginDiscoveryResult: providerMocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: providerMocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: providerMocks.runProviderStaticCatalog,
}));

import { getModelProviderRequestTransport } from "../provider-request-config.js";
import {
  canonicalizeManifestModelCatalogProviderAlias,
  createBundledProviderStaticCatalogContextResolver,
  createBundledProviderStaticCatalogModelResolver,
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
  resolveBundledProviderStaticCatalogModel,
  resolveBundledStaticCatalogModel,
} from "./model.static-catalog.js";

function setManifestPlugins(plugins: unknown[]) {
  // Static catalog resolution reads scan metadata first, then loads the manifest
  // from disk; the mock preserves that two-step contract.
  const byPluginDir = new Map(
    plugins.map((plugin) => {
      const id = (plugin as { id?: string }).id ?? "plugin";
      return [`/fixtures/${id}`, plugin];
    }),
  );
  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue(
    [...byPluginDir].map(([pluginDir, plugin]) => ({
      pluginDir,
      manifest: plugin,
      origin: (plugin as { origin?: string }).origin,
    })),
  );
  manifestMocks.loadPluginManifest.mockImplementation((pluginDir: string) => {
    const plugin = byPluginDir.get(pluginDir);
    return plugin
      ? { ok: true, manifest: plugin }
      : { ok: false, error: "missing manifest", manifestPath: `${pluginDir}/openclaw.plugin.json` };
  });
}

function createMistralManifestPlugin(overrides?: {
  discovery?: "static" | "refreshable" | "runtime";
  origin?: string;
}) {
  // Mistral fixture represents a bundled plugin with a static modelCatalog row.
  return {
    id: "mistral",
    origin: overrides?.origin ?? "bundled",
    providers: ["mistral"],
    modelCatalog: {
      providers: {
        mistral: {
          baseUrl: "https://api.mistral.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "mistral-medium-3-5",
              name: "Mistral Medium 3.5",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 262144,
              maxTokens: 8192,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
              cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
              },
            },
          ],
        },
      },
      discovery: {
        mistral: overrides?.discovery ?? "static",
      },
    },
  };
}

beforeEach(() => {
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReset();
  manifestMocks.listOpenClawPluginManifestMetadata.mockReset();
  manifestMocks.loadPluginManifest.mockReset();
  manifestMocks.loadPluginManifestRegistry.mockReset();
  providerMocks.normalizePluginDiscoveryResult.mockReset();
  providerMocks.resolveActivatableProviderOwnerPluginIds.mockReset();
  providerMocks.resolveBundledProviderCompatPluginIds.mockReset();
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReset();
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockReset();
  providerMocks.runProviderStaticCatalog.mockReset();
  setManifestPlugins([]);
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
  manifestMocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [] });
  providerMocks.resolveActivatableProviderOwnerPluginIds.mockImplementation(
    ({ pluginIds }: { pluginIds: string[] }) => pluginIds,
  );
  providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(undefined);
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
  providerMocks.runProviderStaticCatalog.mockResolvedValue(undefined);
  providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});
});

describe("canonicalizeManifestModelCatalogProviderAlias", () => {
  it("canonicalizes unambiguous manifest-owned aliases", () => {
    manifestMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          providers: ["moonshot"],
          modelCatalog: {
            aliases: {
              "moonshot-ai": { provider: "moonshot" },
              moonshotai: { provider: "moonshot" },
            },
          },
        },
      ],
    });

    for (const provider of ["moonshotai", "moonshot-ai"]) {
      expect(canonicalizeManifestModelCatalogProviderAlias({ provider })).toBe("moonshot");
    }
  });

  it("reuses the current plugin metadata snapshot for repeated alias lookups", () => {
    const plugins = [
      {
        providers: ["moonshot"],
        modelCatalog: {
          aliases: {
            "moonshot-ai": { provider: "moonshot" },
          },
        },
      },
    ];
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins });

    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai" })).toBe(
      "moonshot",
    );
    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai" })).toBe(
      "moonshot",
    );
    expect(manifestMocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenLastCalledWith({
      config: undefined,
      env: process.env,
      requireDefaultDiscoveryContext: true,
      workspaceDir: undefined,
    });
  });

  it("requests an exact configured workspace snapshot", () => {
    const cfg = { plugins: { allow: ["openai"] } };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });

    canonicalizeManifestModelCatalogProviderAlias({
      provider: "openai",
      cfg,
      workspaceDir: "/workspace",
    });

    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      workspaceDir: "/workspace",
    });
  });

  it("keeps custom environments on their own manifest registry context", () => {
    const env = { HOME: "/custom-home" };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
    manifestMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          providers: ["moonshot"],
          modelCatalog: {
            aliases: {
              "moonshot-ai": { provider: "moonshot" },
            },
          },
        },
      ],
    });

    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai", env })).toBe(
      "moonshot",
    );
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: undefined,
      env,
      workspaceDir: undefined,
    });
  });
});

describe("resolveBundledStaticCatalogModel", () => {
  it("reuses one manifest scan across prepared lookups", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    const resolveModel = createBundledStaticCatalogModelResolver();
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-3-5" })?.id).toBe(
      "mistral-medium-3-5",
    );
    expect(resolveModel({ provider: "mistral", modelId: "missing" })).toBeUndefined();
    expect(manifestMocks.listOpenClawPluginManifestMetadata).toHaveBeenCalledTimes(1);
  });

  it("synthesizes a runtime model from an exact bundled static manifest catalog row", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
    });

    expect(model).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      compat: undefined,
      contextTokens: undefined,
      contextWindow: 262144,
      cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
      headers: undefined,
      id: "mistral-medium-3-5",
      input: ["text", "image"],
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low", max: "max" },
    });
  });

  it("ignores non-bundled and non-static manifest catalog rows", () => {
    // Workspace plugins and refreshable/runtime catalogs are not process-stable
    // enough for this fallback path.
    for (const plugin of [
      createMistralManifestPlugin({ origin: "workspace" }),
      createMistralManifestPlugin({ discovery: "refreshable" }),
      createMistralManifestPlugin({ discovery: "runtime" }),
    ]) {
      setManifestPlugins([plugin]);

      expect(
        resolveBundledStaticCatalogModel({
          provider: "mistral",
          modelId: "mistral-medium-3-5",
          cfg: {},
        }),
      ).toBeUndefined();
    }
  });

  it("does not resolve bundled manifest rows blocked by plugin config", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    for (const cfg of [
      { plugins: { enabled: false } },
      { plugins: { entries: { mistral: { enabled: false } } } },
      { plugins: { deny: ["mistral"] } },
      { plugins: { allow: ["google"] } },
    ]) {
      expect(
        resolveBundledStaticCatalogModel({
          provider: "mistral",
          modelId: "mistral-medium-3-5",
          cfg,
        }),
      ).toBeUndefined();
    }
  });

  it("can include bundled runtime-discovery manifest catalog rows for configured fallbacks", () => {
    setManifestPlugins([createMistralManifestPlugin({ discovery: "runtime" })]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
      includeRuntimeDiscovery: true,
    });

    expect(model?.maxTokens).toBe(8192);
  });

  it("requires an exact provider and model match", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-2508",
        cfg: {},
      }),
    ).toBeUndefined();
    expect(
      resolveBundledStaticCatalogModel({
        provider: "openrouter",
        modelId: "mistral-medium-3-5",
        cfg: {},
      }),
    ).toBeUndefined();
  });
});

describe("resolveBundledProviderStaticCatalogModel", () => {
  it("loads every enabled bundled provider static catalog for context warmup", async () => {
    const cfg = { plugins: { entries: { google: { enabled: true } } } };
    const provider = {
      id: "google",
      pluginId: "google",
      label: "Google",
      auth: [],
      staticCatalog: { run: vi.fn() },
    };
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    manifestMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
      ],
    });
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini Pro",
            contextWindow: 1_048_576,
          },
        ],
      },
    });

    await expect(loadBundledProviderStaticCatalogContextModels({ cfg })).resolves.toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro-preview",
        provider: "google",
        contextWindow: 1_048_576,
      }),
    ]);
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: undefined,
      env: process.env,
      onlyPluginIds: ["google"],
      includeUntrustedWorkspacePlugins: false,
      requireCompleteDiscoveryEntryCoverage: true,
      discoveryEntriesOnly: true,
      includeManifestModelCatalogProviders: false,
    });
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });

  it("skips bundled providers without discovery entries during context warmup", async () => {
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google", "openai"]);
    manifestMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
        { id: "openai", origin: "bundled" },
      ],
    });
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);

    await loadBundledProviderStaticCatalogContextModels();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledOnce();
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["google"] }),
    );
  });

  it("keeps successful provider context rows when another static catalog fails", async () => {
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google", "minimax"]);
    manifestMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
        {
          id: "minimax",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/minimax/provider-discovery.ts",
        },
      ],
    });
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
        onlyPluginIds[0] === "google"
          ? [{ id: "google", pluginId: "google", label: "Google", auth: [] }]
          : [{ id: "minimax", pluginId: "minimax", label: "MiniMax", auth: [] }],
    );
    providerMocks.runProviderStaticCatalog.mockImplementation(
      async ({ provider }: { provider: { id: string } }) => {
        if (provider.id === "minimax") {
          throw new Error("catalog unavailable");
        }
        return { marker: "google-static-result" };
      },
    );
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini Pro",
            contextWindow: 1_048_576,
          },
        ],
      },
    });

    await expect(loadBundledProviderStaticCatalogContextModels()).resolves.toEqual([
      expect.objectContaining({ provider: "google", contextWindow: 1_048_576 }),
    ]);
  });

  it("resolves exact rows from bundled provider static catalogs", async () => {
    const cfg = { plugins: { entries: { google: { enabled: true } } } };
    const provider = {
      id: "google",
      pluginId: "google",
      label: "Google",
      auth: [],
      staticCatalog: { run: vi.fn() },
    };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "google-generative-ai",
        authHeader: true,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        request: { headers: { "X-Static-Catalog": "yes" } },
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            mediaInput: { image: { maxSidePx: 3072, tokenMode: "provider" } },
          },
        ],
      },
    });

    const model = await resolveBundledProviderStaticCatalogModel({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg,
    });

    expect(model).toMatchObject({
      api: "google-generative-ai",
      authHeader: true,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      contextTokens: undefined,
      contextWindow: 1_048_576,
      cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
      headers: { "X-Static-Catalog": "yes" },
      id: "gemini-3.1-pro-preview",
      input: ["text", "image"],
      maxTokens: 65_536,
      mediaInput: { image: { maxSidePx: 3072, tokenMode: "provider" } },
      name: "Gemini 3.1 Pro Preview",
      provider: "google",
      reasoning: true,
    });
    expect(getModelProviderRequestTransport(model!)).toEqual({
      headers: { "X-Static-Catalog": "yes" },
    });
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: undefined,
      env: process.env,
      onlyPluginIds: ["google"],
      includeUntrustedWorkspacePlugins: false,
      requireCompleteDiscoveryEntryCoverage: true,
      discoveryEntriesOnly: true,
      includeManifestModelCatalogProviders: false,
    });
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledWith({
      provider,
      config: cfg,
      workspaceDir: undefined,
      env: process.env,
    });
  });

  it("does not load bundled provider static catalogs when owner policy blocks the plugin", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveActivatableProviderOwnerPluginIds.mockReturnValue([]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        cfg: { plugins: { entries: { google: { enabled: false } } } },
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(providerMocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("runs each prepared provider static catalog once", async () => {
    const provider = {
      id: "google",
      pluginId: "google",
      label: "Google",
      auth: [],
      staticCatalog: { run: vi.fn() },
    };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini Pro", contextWindow: 1_048_576 }],
      },
    });

    const resolveModel = createBundledProviderStaticCatalogModelResolver();
    await expect(
      resolveModel({ provider: "google", modelId: "gemini-3.1-pro-preview" }),
    ).resolves.toMatchObject({ contextWindow: 1_048_576 });
    await expect(
      resolveModel({ provider: "google", modelId: "missing-model" }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });

  it("resolves context-only nested model ids within the same owning plugin", async () => {
    const provider = {
      id: "google",
      pluginId: "google",
      label: "Google",
      auth: [],
      staticCatalog: { run: vi.fn() },
    };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider: providerId }: { provider: string }) =>
        providerId === "google" || providerId === "google-gemini-cli" ? ["google"] : undefined,
    );
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            contextWindow: 1_048_576,
            contextTokens: 1_000_000,
            maxTokens: 65_536,
          },
        ],
      },
    });

    const resolveContext = createBundledProviderStaticCatalogContextResolver();
    await expect(
      resolveContext({
        provider: "google-gemini-cli",
        modelId: "google/gemini-3.1-pro-preview",
      }),
    ).resolves.toEqual({
      contextWindow: 1_048_576,
      contextTokens: 1_000_000,
    });
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);

    providerMocks.resolveRuntimePluginDiscoveryProviders.mockClear();
    providerMocks.runProviderStaticCatalog.mockClear();
    const resolveModel = createBundledProviderStaticCatalogModelResolver();
    await expect(
      resolveModel({
        provider: "google-gemini-cli",
        modelId: "google/gemini-3.1-pro-preview",
      }),
    ).resolves.toBeUndefined();
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not borrow nested provider context across plugin owners", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider }: { provider: string }) => {
        if (provider === "openrouter") {
          return ["openrouter"];
        }
        if (provider === "anthropic") {
          return ["anthropic"];
        }
        return undefined;
      },
    );
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([
      "anthropic",
      "openrouter",
    ]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      { id: "openrouter", pluginId: "openrouter", label: "OpenRouter", auth: [] },
    ]);
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});

    const resolveContext = createBundledProviderStaticCatalogContextResolver();
    await expect(
      resolveContext({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });

  it("restricts nested provider context to the shared bundled owner", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider }: { provider: string }) => {
        if (provider === "outer") {
          return ["shared"];
        }
        if (provider === "nested") {
          return ["shared", "unrelated"];
        }
        return undefined;
      },
    );
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["shared", "unrelated"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
        onlyPluginIds.map((pluginId) => ({
          id: pluginId,
          pluginId,
          label: pluginId,
          auth: [],
        })),
    );
    providerMocks.normalizePluginDiscoveryResult.mockImplementation(
      ({ provider }: { provider: { pluginId: string } }) =>
        provider.pluginId === "unrelated"
          ? {
              nested: {
                models: [{ id: "model", name: "Model", contextWindow: 999_999 }],
              },
            }
          : {},
    );

    const resolveContext = createBundledProviderStaticCatalogContextResolver();
    await expect(
      resolveContext({
        provider: "outer",
        modelId: "nested/model",
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["shared"] }),
    );
  });

  it("does not load provider catalogs when the provider owner is not bundled and enabled", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        cfg: {},
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(providerMocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("requires an exact provider and model match", async () => {
    const provider = { id: "google", pluginId: "google", label: "Google", auth: [] };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }],
      },
      "google-vertex": {
        api: "google-vertex",
        baseUrl: "https://aiplatform.googleapis.com/v1",
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }],
      },
    });

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-2.5-pro",
        cfg: {},
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "openrouter",
        modelId: "gemini-3.1-pro-preview",
        cfg: {},
      }),
    ).resolves.toBeUndefined();
  });
});
