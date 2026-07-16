// Covers model catalog loading, plugin manifests, normalization, and suppression.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";

type AgentModelDiscoveryModule = typeof import("./agent-model-discovery.js");

let setModelCatalogImportForTest: typeof import("./model-catalog.js").setModelCatalogImportForTest;
let findModelCatalogEntry: typeof import("./model-catalog.js").findModelCatalogEntry;
let findModelInCatalog: typeof import("./model-catalog.js").findModelInCatalog;
let loadManifestModelCatalog: typeof import("./model-catalog.js").loadManifestModelCatalog;
let loadModelCatalog: typeof import("./model-catalog.js").loadModelCatalog;
let loadModelCatalogSnapshot: typeof import("./model-catalog.js").loadModelCatalogSnapshot;
let modelSupportsInput: typeof import("./model-catalog.js").modelSupportsInput;
let resetModelCatalogCache: typeof import("./model-catalog.js").resetModelCatalogCache;
let resetModelCatalogCacheForTest: typeof import("./model-catalog.js").resetModelCatalogCacheForTest;
let augmentCatalogMock: ReturnType<typeof vi.fn>;
let prepareOpenClawModelsJsonSourceMock: ReturnType<typeof vi.fn>;
let currentPluginMetadataSnapshotMock: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
let loadPluginMetadataSnapshotMock: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
let readFileMock: ReturnType<typeof vi.fn<(pathname: string) => Promise<string>>>;
let buildAgentModelCatalogCacheKeyMock: ReturnType<typeof vi.fn>;
let buildModelsJsonSourceFingerprintMock: ReturnType<typeof vi.fn>;
let readCachedAgentModelCatalogMock: ReturnType<
  typeof vi.fn<(params: { agentDir: string; catalogKey: string }) => unknown[] | undefined>
>;
let readCachedAgentModelCatalogSnapshotMock: ReturnType<typeof vi.fn>;
let writeCachedAgentModelCatalogMock: ReturnType<typeof vi.fn>;

vi.mock("./model-suppression.runtime.js", () => ({
  shouldSuppressBuiltInModel: (params: { provider?: string; id?: string; baseUrl?: string }) =>
    isSuppressedModel(params.provider, params.id, params.baseUrl),
  buildShouldSuppressBuiltInModel:
    () => (params: { provider?: string; id?: string; baseUrl?: string }) =>
      isSuppressedModel(params.provider, params.id, params.baseUrl),
}));

function isDirectOpenAiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return true;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
  } catch {
    return false;
  }
}

function isSuppressedModel(provider?: string, id?: string, baseUrl?: string): boolean {
  const modelId = id?.trim().toLowerCase();
  if (!modelId) {
    return false;
  }
  if (modelId !== "gpt-5.3-codex-spark") {
    return false;
  }
  if (provider === "azure-openai-responses") {
    return true;
  }
  return provider === "openai" && isDirectOpenAiBaseUrl(baseUrl);
}

function mockCatalogImportFailThenRecover() {
  // Simulates a transient discovery import failure so cache/error handling can
  // prove the catalog loader recovers on the next attempt.
  let call = 0;
  setModelCatalogImportForTest(async () => {
    call += 1;
    if (call === 1) {
      throw new Error("boom");
    }
    return {
      discoverAuthStorage: () => ({}),
      AuthStorage: function AuthStorage() {},
      discoverModels: () => ({
        getAll() {
          return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
        },
      }),
      ModelRegistry: class {
        getAll() {
          return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
        }
      },
    } as unknown as AgentModelDiscoveryModule;
  });
  return () => call;
}

function mockAgentDiscoveryModels(models: unknown[]) {
  setModelCatalogImportForTest(
    async () =>
      ({
        discoverAuthStorage: () => ({}),
        AuthStorage: function AuthStorage() {},
        discoverModels: () => ({
          getAll() {
            return models;
          },
        }),
        ModelRegistry: class {
          getAll() {
            return models;
          }
        },
      }) as unknown as AgentModelDiscoveryModule,
  );
}

function mockSingleOpenAiCatalogModel() {
  mockAgentDiscoveryModels([{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }]);
}

function emptyPluginMetadataSnapshot() {
  return {
    policyHash: "test-policy",
    configFingerprint: "test-config",
    index: {
      policyHash: "test-policy",
      plugins: [],
    },
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    plugins: [],
  };
}

function modelIdNormalizationSnapshot() {
  return {
    ...emptyPluginMetadataSnapshot(),
    configFingerprint: "model-id-normalizers",
    plugins: [
      {
        id: "external-normalizer",
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                latest: "modern-model",
              },
              stripPrefixes: ["legacy/"],
              prefixWhenBare: "vendor",
            },
          },
        },
      },
    ],
  };
}

function manifestModelCatalogSnapshot(model: {
  id: string;
  name?: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
}) {
  // Minimal plugin metadata snapshot containing a manifest-owned external
  // provider model catalog.
  return {
    policyHash: "policy",
    index: {
      policyHash: "policy",
      plugins: [
        {
          pluginId: "external-provider",
          enabled: true,
          origin: "global",
        },
      ],
    },
    plugins: [
      {
        id: "external-provider",
        origin: "global",
        modelCatalog: {
          providers: {
            external: {
              models: [
                {
                  name: model.id,
                  ...model,
                },
              ],
            },
          },
        },
      },
    ],
  };
}

function configuredModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

type ModelCatalogEntry = Awaited<
  ReturnType<typeof import("./model-catalog.js").loadModelCatalog>
>[number];

function findCatalogEntry(
  entries: readonly ModelCatalogEntry[],
  provider: string,
  id: string,
): ModelCatalogEntry | undefined {
  return entries.find((entry) => entry.provider === provider && entry.id === id);
}

function requireCatalogEntry(
  entries: readonly ModelCatalogEntry[],
  provider: string,
  id: string,
): ModelCatalogEntry {
  // Most catalog tests need a narrowed entry before checking capabilities or
  // normalized ids; fail loudly when the fixture model disappears.
  const entry = findCatalogEntry(entries, provider, id);
  if (!entry) {
    throw new Error(`expected catalog entry ${provider}/${id}`);
  }
  return entry;
}

function expectNoCatalogEntry(entries: readonly ModelCatalogEntry[], provider: string, id: string) {
  expect(findCatalogEntry(entries, provider, id)).toBeUndefined();
}

function requireMockCallParam(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const first = mock.mock.calls[0]?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error(`expected ${label}`);
  }
  return first as Record<string, unknown>;
}

describe("loadModelCatalog", () => {
  beforeAll(async () => {
    vi.resetModules();
    readFileMock = vi.fn<(pathname: string) => Promise<string>>();
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      readFile: readFileMock,
    }));
    prepareOpenClawModelsJsonSourceMock = vi.fn().mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "source-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
      wrote: false,
    });
    buildModelsJsonSourceFingerprintMock = vi.fn().mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "source-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    vi.doMock("./models-config.js", () => ({
      buildModelsJsonSourceFingerprint: buildModelsJsonSourceFingerprintMock,
      prepareOpenClawModelsJsonSource: prepareOpenClawModelsJsonSourceMock,
    }));
    buildAgentModelCatalogCacheKeyMock = vi.fn(
      (input: { cacheScope?: { sourceFingerprint?: string } }) =>
        `test-cache-key:${input.cacheScope?.sourceFingerprint ?? "none"}`,
    );
    readCachedAgentModelCatalogMock = vi.fn<
      (params: { agentDir: string; catalogKey: string }) => unknown[] | undefined
    >(() => undefined);
    readCachedAgentModelCatalogSnapshotMock = vi.fn((params) => {
      const entries = readCachedAgentModelCatalogMock(params);
      return entries ? { entries, routeVariants: entries } : undefined;
    });
    writeCachedAgentModelCatalogMock = vi.fn();
    vi.doMock("./model-catalog-state-cache.js", () => ({
      buildAgentModelCatalogCacheKey: buildAgentModelCatalogCacheKeyMock,
      readCachedAgentModelCatalog: readCachedAgentModelCatalogMock,
      readCachedAgentModelCatalogSnapshot: readCachedAgentModelCatalogSnapshotMock,
      writeCachedAgentModelCatalog: writeCachedAgentModelCatalogMock,
    }));
    vi.doMock("./agent-scope.js", () => ({
      resolveAgentWorkspaceDir: (cfg: OpenClawConfig, agentId: string) => {
        const entry = cfg.agents?.list?.find((entryEntry) => entryEntry.id === agentId);
        return entry?.workspace ?? cfg.agents?.defaults?.workspace ?? "/tmp/openclaw-workspace";
      },
      resolveDefaultAgentDir: () => "/tmp/openclaw",
      resolveDefaultAgentId: (cfg: OpenClawConfig) =>
        cfg.agents?.list?.find((entry) => entry.default)?.id ?? cfg.agents?.list?.[0]?.id ?? "main",
    }));
    vi.doMock("../plugins/provider-runtime.runtime.js", () => ({
      augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
    }));
    currentPluginMetadataSnapshotMock = vi.fn(() => emptyPluginMetadataSnapshot());
    loadPluginMetadataSnapshotMock = vi.fn(() => emptyPluginMetadataSnapshot());
    vi.doMock("../plugins/current-plugin-metadata-snapshot.js", () => ({
      getCurrentPluginMetadataSnapshot: currentPluginMetadataSnapshotMock,
    }));
    vi.doMock("../plugins/plugin-metadata-snapshot.js", () => ({
      loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
      resolvePluginMetadataSnapshot: (...args: unknown[]) =>
        currentPluginMetadataSnapshotMock(...args) ?? loadPluginMetadataSnapshotMock(...args),
    }));
    vi.doMock("../plugins/manifest-contract-eligibility.js", () => ({
      isManifestPluginAvailableForControlPlane: ({
        plugin,
        snapshot,
      }: {
        plugin: { id: string; origin?: string };
        snapshot: {
          index?: { plugins?: Array<{ pluginId?: string; id?: string; enabled?: boolean }> };
        };
      }) =>
        plugin.origin === "bundled" ||
        Boolean(
          snapshot.index?.plugins?.some(
            (entry) => (entry.pluginId ?? entry.id) === plugin.id && entry.enabled !== false,
          ),
        ),
      loadManifestMetadataSnapshot: (...args: unknown[]) =>
        currentPluginMetadataSnapshotMock(...args) ?? loadPluginMetadataSnapshotMock(...args),
    }));

    ({
      setModelCatalogImportForTest,
      findModelCatalogEntry,
      findModelInCatalog,
      loadManifestModelCatalog,
      loadModelCatalog,
      loadModelCatalogSnapshot,
      modelSupportsInput,
      resetModelCatalogCache,
      resetModelCatalogCacheForTest,
    } = await import("./model-catalog.js"));
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    augmentCatalogMock = vi.mocked(providerRuntime.augmentModelCatalogWithProviderPlugins);
  });

  beforeEach(() => {
    resetModelCatalogCacheForTest();
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(
      Object.assign(new Error("models.json missing"), { code: "ENOENT" }),
    );
    prepareOpenClawModelsJsonSourceMock.mockReset();
    prepareOpenClawModelsJsonSourceMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "source-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
      wrote: false,
    });
    augmentCatalogMock.mockClear();
    currentPluginMetadataSnapshotMock.mockReset();
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadPluginMetadataSnapshotMock.mockReset();
    loadPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot());
    buildModelsJsonSourceFingerprintMock.mockClear();
    buildModelsJsonSourceFingerprintMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "source-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    buildAgentModelCatalogCacheKeyMock.mockClear();
    readCachedAgentModelCatalogMock.mockReset();
    readCachedAgentModelCatalogMock.mockReturnValue(undefined);
    readCachedAgentModelCatalogSnapshotMock.mockReset();
    readCachedAgentModelCatalogSnapshotMock.mockImplementation((params) => {
      const entries = readCachedAgentModelCatalogMock(params);
      return entries ? { entries, routeVariants: entries } : undefined;
    });
    writeCachedAgentModelCatalogMock.mockClear();
  });

  afterEach(() => {
    setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("./models-config.js");
    vi.doUnmock("./model-catalog-state-cache.js");
    vi.doUnmock("./agent-scope.js");
    vi.doUnmock("../plugins/provider-runtime.runtime.js");
    vi.doUnmock("../plugins/current-plugin-metadata-snapshot.js");
    vi.doUnmock("../plugins/plugin-metadata-snapshot.js");
    vi.doUnmock("../plugins/manifest-contract-eligibility.js");
  });

  it("retries after import failure without poisoning the cache", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    try {
      const getCallCount = mockCatalogImportFailThenRecover();

      const cfg = {} as OpenClawConfig;
      const first = await loadModelCatalog({ config: cfg });
      expect(first).toStrictEqual([]);

      const second = await loadModelCatalog({ config: cfg });
      expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      expect(getCallCount()).toBe(2);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("uses the resolved default agent workspace for registry discovery", async () => {
    const discoverModels = vi.fn(() => ({
      getAll() {
        return [];
      },
    }));
    setModelCatalogImportForTest(
      async () =>
        ({
          discoverAuthStorage: () => ({}),
          AuthStorage: function AuthStorage() {},
          discoverModels,
          ModelRegistry: class {
            getAll() {
              return [];
            }
          },
        }) as unknown as AgentModelDiscoveryModule,
    );
    const config = {
      agents: {
        list: [{ id: "workspace-agent", default: true, workspace: "/tmp/workspace-agent" }],
      },
    } as OpenClawConfig;

    await loadModelCatalog({ config });

    expect(discoverModels).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/openclaw",
      expect.objectContaining({ config, workspaceDir: "/tmp/workspace-agent" }),
    );
  });

  it("uses the state cached catalog before runtime discovery", async () => {
    const cached = [{ id: "cached-fast", name: "Cached Fast", provider: "openai" }];
    readCachedAgentModelCatalogMock.mockReturnValueOnce(cached);
    const importAgentDiscoveryModule = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    setModelCatalogImportForTest(
      importAgentDiscoveryModule as unknown as () => Promise<AgentModelDiscoveryModule>,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toEqual(cached);
    expect(readCachedAgentModelCatalogMock).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:source-fingerprint",
    });
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(importAgentDiscoveryModule).not.toHaveBeenCalled();
    expect(writeCachedAgentModelCatalogMock).not.toHaveBeenCalled();
  });

  it("includes injected metadata snapshots in the state cache key", async () => {
    const cached = [{ id: "cached-fast", name: "Cached Fast", provider: "openai" }];
    const metadataSnapshot = emptyPluginMetadataSnapshot();
    readCachedAgentModelCatalogMock.mockReturnValueOnce(cached);

    const result = await loadModelCatalog({
      config: {} as OpenClawConfig,
      metadataSnapshot: metadataSnapshot as never,
    });

    expect(result).toEqual(cached);
    expect(buildAgentModelCatalogCacheKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot }),
    );
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(writeCachedAgentModelCatalogMock).not.toHaveBeenCalled();
  });

  it("bypasses the state cached catalog when a refresh is requested", async () => {
    readCachedAgentModelCatalogMock.mockReturnValue([
      { id: "cached-stale", name: "Cached Stale", provider: "openai" },
    ]);
    mockAgentDiscoveryModels([{ id: "fresh-fast", name: "Fresh Fast", provider: "openai" }]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, useCache: false });

    expect(result).toEqual([{ id: "fresh-fast", name: "Fresh Fast", provider: "openai" }]);
    expect(readCachedAgentModelCatalogMock).not.toHaveBeenCalled();
    expect(writeCachedAgentModelCatalogMock).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:source-fingerprint",
      entries: result,
      routeVariants: result,
    });
  });

  it("writes runtime discovery results to the state catalog cache", async () => {
    mockAgentDiscoveryModels([{ id: "runtime-fast", name: "Runtime Fast", provider: "openai" }]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toEqual([{ id: "runtime-fast", name: "Runtime Fast", provider: "openai" }]);
    expect(writeCachedAgentModelCatalogMock).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:source-fingerprint",
      entries: result,
      routeVariants: result,
    });
  });

  it("exposes only a fully loaded process catalog snapshot", async () => {
    mockAgentDiscoveryModels([
      { id: "runtime-reasoner", name: "Runtime Reasoner", provider: "ollama", reasoning: true },
    ]);
    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toEqual([]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toBe(result);
    resetModelCatalogCache();
    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toEqual([]);
    resetModelCatalogCacheForTest();
    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toEqual([]);
  });

  it("does not publish a catalog load from an invalidated generation", async () => {
    let releaseStaleFingerprint:
      | ((value: { agentDir: string; fingerprint: string; workspaceDir: string }) => void)
      | undefined;
    const staleFingerprint = new Promise<{
      agentDir: string;
      fingerprint: string;
      workspaceDir: string;
    }>((resolve) => {
      releaseStaleFingerprint = resolve;
    });
    buildModelsJsonSourceFingerprintMock.mockReturnValueOnce(staleFingerprint).mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "fresh-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    const freshCatalog = [{ id: "fresh", name: "Fresh", provider: "ollama", reasoning: true }];
    const staleCatalog = [{ id: "stale", name: "Stale", provider: "ollama", reasoning: false }];
    readCachedAgentModelCatalogMock
      .mockReturnValueOnce(freshCatalog)
      .mockReturnValueOnce(staleCatalog);

    const staleLoad = loadModelCatalog({ config: {} as OpenClawConfig });
    resetModelCatalogCache();
    await expect(loadModelCatalog({ config: {} as OpenClawConfig })).resolves.toBe(freshCatalog);
    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toBe(freshCatalog);

    releaseStaleFingerprint?.({
      agentDir: "/tmp/openclaw",
      fingerprint: "stale-fingerprint",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    await expect(staleLoad).resolves.toBe(staleCatalog);
    await expect(loadModelCatalog({ cacheOnly: true })).resolves.toBe(freshCatalog);
  });

  it("preserves runtime model params in the internal catalog", async () => {
    mockAgentDiscoveryModels([
      {
        id: "company-fable",
        name: "Company Fable",
        provider: "amazon-bedrock",
        params: { canonicalModelId: "claude-fable-5" },
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toEqual([
      {
        id: "company-fable",
        name: "Company Fable",
        provider: "amazon-bedrock",
        params: { canonicalModelId: "claude-fable-5" },
      },
    ]);
  });

  it("writes runtime discovery results under the refreshed models.json fingerprint", async () => {
    buildModelsJsonSourceFingerprintMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "pre-refresh-source",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    prepareOpenClawModelsJsonSourceMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "post-refresh-source",
      workspaceDir: "/tmp/openclaw-workspace",
      wrote: true,
    });
    mockAgentDiscoveryModels([{ id: "runtime-fast", name: "Runtime Fast", provider: "openai" }]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toEqual([{ id: "runtime-fast", name: "Runtime Fast", provider: "openai" }]);
    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(1, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:pre-refresh-source",
    });
    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(2, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:post-refresh-source",
    });
    expect(writeCachedAgentModelCatalogMock).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:post-refresh-source",
      entries: result,
      routeVariants: result,
    });
  });

  it("uses a refreshed state cached catalog before runtime discovery", async () => {
    const cached = [{ id: "cached-fast", name: "Cached Fast", provider: "openai" }];
    buildModelsJsonSourceFingerprintMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "pre-refresh-source",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    prepareOpenClawModelsJsonSourceMock.mockResolvedValue({
      agentDir: "/tmp/openclaw",
      fingerprint: "post-refresh-source",
      workspaceDir: "/tmp/openclaw-workspace",
      wrote: true,
    });
    readCachedAgentModelCatalogMock.mockImplementation(({ catalogKey }: { catalogKey: string }) =>
      catalogKey.endsWith("post-refresh-source") ? cached : undefined,
    );
    const importAgentDiscoveryModule = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    setModelCatalogImportForTest(
      importAgentDiscoveryModule as unknown as () => Promise<AgentModelDiscoveryModule>,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toEqual(cached);
    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(1, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:pre-refresh-source",
    });
    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(2, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:post-refresh-source",
    });
    expect(importAgentDiscoveryModule).not.toHaveBeenCalled();
    expect(writeCachedAgentModelCatalogMock).not.toHaveBeenCalled();
  });

  it("misses the state cached catalog when source freshness changes", async () => {
    buildModelsJsonSourceFingerprintMock
      .mockResolvedValueOnce({
        agentDir: "/tmp/openclaw",
        fingerprint: "old-source",
        workspaceDir: "/tmp/openclaw-workspace",
      })
      .mockResolvedValueOnce({
        agentDir: "/tmp/openclaw",
        fingerprint: "new-source",
        workspaceDir: "/tmp/openclaw-workspace",
      });
    readCachedAgentModelCatalogMock.mockImplementation(({ catalogKey }: { catalogKey: string }) =>
      catalogKey.endsWith("old-source")
        ? [{ id: "cached-stale", name: "Cached Stale", provider: "openai" }]
        : undefined,
    );
    mockAgentDiscoveryModels([{ id: "fresh-fast", name: "Fresh Fast", provider: "openai" }]);

    await expect(loadModelCatalog({ config: {} as OpenClawConfig })).resolves.toEqual([
      { id: "cached-stale", name: "Cached Stale", provider: "openai" },
    ]);
    resetModelCatalogCacheForTest();
    mockAgentDiscoveryModels([{ id: "fresh-fast", name: "Fresh Fast", provider: "openai" }]);
    await expect(loadModelCatalog({ config: {} as OpenClawConfig })).resolves.toEqual([
      { id: "fresh-fast", name: "Fresh Fast", provider: "openai" },
    ]);

    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(1, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:old-source",
    });
    expect(readCachedAgentModelCatalogMock).toHaveBeenNthCalledWith(2, {
      agentDir: "/tmp/openclaw",
      catalogKey: "test-cache-key:new-source",
    });
  });

  it("reloads dynamic registry entries after clearing the cache", async () => {
    const models = [{ id: "existing", name: "Existing", provider: "ollama" }];
    mockAgentDiscoveryModels(models);

    const first = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(first).toStrictEqual([
      {
        id: "existing",
        name: "Existing",
        provider: "ollama",
        contextWindow: undefined,
        reasoning: undefined,
        input: undefined,
        compat: undefined,
      },
    ]);

    models.push({ id: "glm-5.1:cloud", name: "GLM 5.1 Cloud", provider: "ollama" });
    resetModelCatalogCacheForTest();
    mockAgentDiscoveryModels(models);

    const second = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(second).toStrictEqual([
      {
        id: "existing",
        name: "Existing",
        provider: "ollama",
        contextWindow: undefined,
        reasoning: undefined,
        input: undefined,
        compat: undefined,
      },
      {
        id: "glm-5.1:cloud",
        name: "GLM 5.1 Cloud",
        provider: "ollama",
        contextWindow: undefined,
        reasoning: undefined,
        input: undefined,
        compat: undefined,
      },
    ]);
  });

  it("returns partial results on discovery errors", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    try {
      setModelCatalogImportForTest(
        async () =>
          ({
            discoverAuthStorage: () => ({}),
            AuthStorage: function AuthStorage() {},
            discoverModels: () => ({
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    provider: "openai",
                    name: "bad",
                  },
                ];
              },
            }),
            ModelRegistry: class {
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    provider: "openai",
                    name: "bad",
                  },
                ];
              }
            },
          }) as unknown as AgentModelDiscoveryModule,
      );

      const result = await loadModelCatalog({ config: {} as OpenClawConfig });
      expect(result).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      await expect(loadModelCatalog({ cacheOnly: true })).resolves.toEqual([]);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("does not prepare models.json or import provider discovery when loading fallback catalog in read-only mode", async () => {
    const importAgentDiscoveryModule = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    setModelCatalogImportForTest(
      importAgentDiscoveryModule as unknown as () => Promise<AgentModelDiscoveryModule>,
    );
    currentPluginMetadataSnapshotMock.mockReturnValueOnce(undefined);
    loadPluginMetadataSnapshotMock.mockImplementationOnce(() => {
      throw new Error("metadata scan should not run");
    });

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                {
                  id: "gpt-test",
                  name: "GPT Test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      readOnly: true,
    });

    const entry = requireCatalogEntry(result, "openai", "gpt-test");
    expect(entry.name).toBe("GPT Test");
    expect(entry.baseUrl).toBe("https://openai.example.com/v1");
    expect(readCachedAgentModelCatalogMock).not.toHaveBeenCalled();
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(importAgentDiscoveryModule).not.toHaveBeenCalled();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("filters suppressed built-ins from persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                name: "GPT-5.3 Codex Spark",
                reasoning: true,
                contextWindow: 128000,
                input: ["text"],
              },
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                reasoning: true,
                contextWindow: 272000,
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
        compat: undefined,
      },
    ]);
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("loads generated plugin catalog rows in read-only mode", async () => {
    const catalogPath = "/tmp/openclaw/plugins/read-only-shard/catalog.json";
    mkdirSync("/tmp/openclaw/plugins/read-only-shard", { recursive: true });
    writeFileSync(catalogPath, "{}");
    try {
      readFileMock.mockImplementation(async (pathname: string) => {
        if (pathname.endsWith("models.json")) {
          return JSON.stringify({ providers: {} });
        }
        if (pathname === catalogPath) {
          return JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              zai: {
                models: [
                  {
                    id: "glm-5.1",
                    name: "GLM 5.1",
                    reasoning: true,
                    contextWindow: 131072,
                    input: ["text"],
                  },
                ],
              },
            },
          });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      loadPluginMetadataSnapshotMock.mockReturnValueOnce({
        ...emptyPluginMetadataSnapshot(),
        index: {
          policyHash: "test-policy",
          plugins: [{ pluginId: "read-only-shard", enabled: true }],
        },
        normalizePluginId: (id: string) => id,
        owners: {
          providers: new Map([["zai", ["read-only-shard"]]]),
          modelCatalogProviders: new Map([["zai", ["read-only-shard"]]]),
          setupProviders: new Map(),
        },
      });

      const result = await loadModelCatalog({
        config: {
          agents: {
            list: [{ id: "workspace-agent", default: true, workspace: "/tmp/read-only-workspace" }],
          },
        } as OpenClawConfig,
        readOnly: true,
      });

      expect(requireCatalogEntry(result, "zai", "glm-5.1")).toMatchObject({
        provider: "zai",
        id: "glm-5.1",
        name: "GLM 5.1",
        reasoning: true,
        contextWindow: 131072,
      });
      expect(
        loadPluginMetadataSnapshotMock.mock.calls.some(([call]) => {
          return (
            typeof call === "object" &&
            call !== null &&
            (call as { workspaceDir?: string }).workspaceDir === "/tmp/read-only-workspace"
          );
        }),
      ).toBe(true);
    } finally {
      rmSync("/tmp/openclaw/plugins/read-only-shard", { recursive: true, force: true });
    }
  });

  it("preserves sidecar and manifest physical routes in the read-only catalog", async () => {
    const catalogPath = "/tmp/openclaw/plugins/openai/catalog.json";
    mkdirSync("/tmp/openclaw/plugins/openai", { recursive: true });
    writeFileSync(catalogPath, "{}");
    const metadataSnapshot = {
      ...emptyPluginMetadataSnapshot(),
      index: {
        policyHash: "test-policy",
        plugins: [{ pluginId: "openai", enabled: true, origin: "bundled" }],
      },
      normalizePluginId: (id: string) => id,
      owners: {
        providers: new Map([["openai", ["openai"]]]),
        modelCatalogProviders: new Map([["openai", ["openai"]]]),
        setupProviders: new Map(),
      },
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          providers: ["openai"],
          modelCatalog: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.4-nano",
                    name: "Platform Nano",
                    input: ["text", "image"],
                    contextWindow: 1_000_000,
                  },
                ],
              },
            },
          },
        },
      ],
    };
    try {
      readFileMock.mockImplementation(async (pathname: string) => {
        if (pathname.endsWith("models.json")) {
          return JSON.stringify({ providers: {} });
        }
        if (pathname === catalogPath) {
          return JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              openai: {
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [
                  {
                    id: "gpt-5.4-nano",
                    name: "ChatGPT Nano",
                    input: ["text"],
                    contextWindow: 400_000,
                  },
                ],
              },
            },
          });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      currentPluginMetadataSnapshotMock.mockReturnValue(metadataSnapshot);

      const snapshot = await loadModelCatalogSnapshot({
        config: {} as OpenClawConfig,
        readOnly: true,
        metadataSnapshot: metadataSnapshot as never,
      });
      const catalog = snapshot.entries;

      expect(catalog).toHaveLength(1);
      expect(catalog[0]).toMatchObject({ name: "Platform Nano", api: "openai-responses" });
      expect(snapshot.routeVariants).toEqual([
        expect.objectContaining({
          name: "ChatGPT Nano",
          api: "openai-chatgpt-responses",
          contextWindow: 400_000,
        }),
        expect.objectContaining({
          name: "Platform Nano",
          api: "openai-responses",
          contextWindow: 1_000_000,
        }),
      ]);
    } finally {
      rmSync("/tmp/openclaw/plugins/openai", { recursive: true, force: true });
    }
  });

  it("falls back to manifest catalog rows when persisted read-only catalog has no model rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          openai: {
            modelOverrides: {
              "gpt-4.1": {
                contextWindow: 128000,
              },
            },
          },
        },
      }),
    );
    currentPluginMetadataSnapshotMock.mockReturnValueOnce({
      policyHash: "policy",
      index: {
        policyHash: "policy",
        plugins: [
          {
            pluginId: "external-provider",
            enabled: true,
            origin: "global",
          },
        ],
      },
      plugins: [
        {
          id: "external-provider",
          origin: "global",
          modelCatalog: {
            providers: {
              external: {
                models: [{ id: "external-fast", name: "External Fast" }],
              },
            },
          },
        },
      ],
    });
    const importAgentDiscoveryModule = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    setModelCatalogImportForTest(
      importAgentDiscoveryModule as unknown as () => Promise<AgentModelDiscoveryModule>,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "External Fast",
        input: ["text"],
        reasoning: false,
      },
    ]);
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(importAgentDiscoveryModule).not.toHaveBeenCalled();
  });

  it("preserves registry defaults for minimal persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            models: [{ id: "local-tiny" }],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "custom",
        id: "local-tiny",
        name: "local-tiny",
        reasoning: false,
        contextWindow: 128000,
        input: ["text"],
        compat: undefined,
      },
    ]);
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("inherits provider API and canonical Fable reasoning in persisted rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          "microsoft-foundry": {
            api: "anthropic-messages",
            models: [
              {
                id: "company-fable",
                reasoning: false,
                params: { canonicalModelId: "claude-fable-5" },
              },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });
    const entry = requireCatalogEntry(result, "microsoft-foundry", "company-fable");

    expect(entry.api).toBe("anthropic-messages");
    expect(entry.reasoning).toBe(true);
  });

  it("refreshes stale persisted read-only rows with manifest catalog metadata", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          xai: {
            models: [
              {
                id: "grok-4.3",
                name: "Grok 4.3",
                reasoning: false,
                contextWindow: 200_000,
                input: ["text"],
              },
            ],
          },
        },
      }),
    );
    currentPluginMetadataSnapshotMock.mockReturnValue({
      ...emptyPluginMetadataSnapshot(),
      plugins: [
        {
          id: "xai",
          origin: "bundled",
          providers: ["xai"],
          modelCatalog: {
            providers: {
              xai: {
                models: [
                  {
                    id: "grok-4.3",
                    name: "Grok 4.3",
                    reasoning: true,
                    contextWindow: 1_000_000,
                    input: ["text", "image"],
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    const entry = requireCatalogEntry(result, "xai", "grok-4.3");
    expect(result.filter((entryValue) => entryValue.provider === "xai")).toHaveLength(1);
    expect(entry.contextWindow).toBe(1_000_000);
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.reasoning).toBe(true);
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("normalizes persisted read-only catalog rows with manifest model id policies", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(modelIdNormalizationSnapshot());
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            models: [
              { id: "latest", name: "Latest Alias" },
              { id: "legacy/trimmed" },
              { id: "vendor/already-prefixed" },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(requireCatalogEntry(result, "custom", "vendor/modern-model").name).toBe("Latest Alias");
    expect(requireCatalogEntry(result, "custom", "vendor/trimmed").name).toBe("vendor/trimmed");
    expect(requireCatalogEntry(result, "custom", "vendor/already-prefixed").name).toBe(
      "vendor/already-prefixed",
    );
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("reuses injected metadata for persisted read-only catalog normalization", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            models: [{ id: "latest", name: "Latest Alias" }],
          },
        },
      }),
    );

    const result = await loadModelCatalog({
      config: {} as OpenClawConfig,
      readOnly: true,
      metadataSnapshot: modelIdNormalizationSnapshot() as unknown as NonNullable<
        Parameters<typeof loadModelCatalog>[0]
      >["metadataSnapshot"],
    });

    expect(requireCatalogEntry(result, "custom", "vendor/modern-model").name).toBe("Latest Alias");
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("reuses injected metadata when read-only catalog falls back to manifest rows", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const metadataSnapshot = {
      ...emptyPluginMetadataSnapshot(),
      index: {
        policyHash: "policy",
        plugins: [
          {
            pluginId: "external-provider",
            enabled: true,
            origin: "global",
          },
        ],
      },
      plugins: [
        {
          id: "external-provider",
          origin: "global",
          modelCatalog: {
            providers: {
              external: {
                models: [{ id: "external-fast", name: "External Fast" }],
              },
            },
          },
        },
      ],
    };

    const result = await loadModelCatalog({
      config: {} as OpenClawConfig,
      readOnly: true,
      metadataSnapshot: metadataSnapshot as unknown as NonNullable<
        Parameters<typeof loadModelCatalog>[0]
      >["metadataSnapshot"],
    });

    expect(result).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "External Fast",
        input: ["text"],
        reasoning: false,
      },
    ]);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("loads manifest model id policies once for persisted read-only catalog rows", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadPluginMetadataSnapshotMock.mockReturnValue(modelIdNormalizationSnapshot());
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            models: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }, { id: "model-d" }],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(requireCatalogEntry(result, "custom", "vendor/model-a").id).toBe("vendor/model-a");
    expect(requireCatalogEntry(result, "custom", "vendor/model-d").id).toBe("vendor/model-d");
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads manifest model id policies once for configured read-only catalog rows", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadPluginMetadataSnapshotMock.mockReturnValue(modelIdNormalizationSnapshot());

    const result = await loadModelCatalog({
      readOnly: true,
      config: {
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://custom.example/v1",
              models: [
                configuredModel("model-a"),
                configuredModel("model-b"),
                configuredModel("model-c"),
                configuredModel("model-d"),
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireCatalogEntry(result, "custom", "vendor/model-a").id).toBe("vendor/model-a");
    expect(requireCatalogEntry(result, "custom", "vendor/model-d").id).toBe("vendor/model-d");
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads manifest model id policies once for discovered catalog rows", async () => {
    currentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadPluginMetadataSnapshotMock.mockReturnValue(modelIdNormalizationSnapshot());
    mockAgentDiscoveryModels([
      { provider: "custom", id: "model-a", name: "Model A" },
      { provider: "custom", id: "model-b", name: "Model B" },
      { provider: "custom", id: "model-c", name: "Model C" },
      { provider: "custom", id: "model-d", name: "Model D" },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, useCache: false });

    expect(requireCatalogEntry(result, "custom", "vendor/model-a").name).toBe("Model A");
    expect(requireCatalogEntry(result, "custom", "vendor/model-d").name).toBe("Model D");
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("preserves provider context defaults for persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            contextWindow: 262144,
            models: [
              { id: "inherits-provider-context" },
              { id: "overrides-context", contextWindow: 65536 },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "custom",
        id: "inherits-provider-context",
        name: "inherits-provider-context",
        reasoning: false,
        contextWindow: 262144,
        input: ["text"],
        compat: undefined,
      },
      {
        provider: "custom",
        id: "overrides-context",
        name: "overrides-context",
        reasoning: false,
        contextWindow: 65536,
        input: ["text"],
        compat: undefined,
      },
    ]);
    expect(prepareOpenClawModelsJsonSourceMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("does not synthesize stale openai/gpt-5.3-codex-spark entries from gpt-5.4", async () => {
    mockAgentDiscoveryModels([
      {
        id: "gpt-5.4",
        provider: "openai",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 200000,
        input: ["text"],
      },
      {
        id: "gpt-5.2-codex",
        provider: "openai",
        name: "GPT-5.2 Codex",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expectNoCatalogEntry(result, "openai", "gpt-5.3-codex-spark");
    const entry = requireCatalogEntry(result, "openai", "gpt-5.4");
    expect(entry.name).toBe("GPT-5.3 Codex");
  });

  it("filters stale gpt-5.3-codex-spark built-ins from the catalog", async () => {
    mockAgentDiscoveryModels([
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "azure-openai-responses",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expectNoCatalogEntry(result, "openai", "gpt-5.3-codex-spark");
    expectNoCatalogEntry(result, "azure-openai-responses", "gpt-5.3-codex-spark");
    expectNoCatalogEntry(result, "openai", "gpt-5.3-codex-spark");
  });

  it("keeps custom endpoint gpt-5.3-codex-spark rows in the catalog", async () => {
    mockAgentDiscoveryModels([
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        name: "GPT-5.3 Codex Spark",
        contextWindow: 128000,
        input: ["text"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        name: "GPT-5.3 Codex Spark Proxy",
        contextWindow: 128000,
        input: ["text"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    const entry = requireCatalogEntry(result, "openai", "gpt-5.3-codex-spark");
    expect(entry.name).toBe("GPT-5.3 Codex Spark Proxy");
    expect(entry.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("keeps available openai 5.1/5.2/5.3 built-ins in the catalog", async () => {
    mockAgentDiscoveryModels([
      {
        id: "gpt-5.1-codex-mini",
        provider: "openai",
        name: "GPT-5.1 Codex Mini",
        reasoning: true,
        contextWindow: 400000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.2-codex",
        provider: "openai",
        name: "GPT-5.2 Codex",
        reasoning: true,
        contextWindow: 400000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex",
        provider: "openai",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 400000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.5",
        provider: "openai",
        name: "GPT-5.5",
        reasoning: true,
        contextWindow: 400000,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(requireCatalogEntry(result, "openai", "gpt-5.1-codex-mini").name).toBe(
      "GPT-5.1 Codex Mini",
    );
    expect(requireCatalogEntry(result, "openai", "gpt-5.2-codex").name).toBe("GPT-5.2 Codex");
    expect(requireCatalogEntry(result, "openai", "gpt-5.3-codex").name).toBe("GPT-5.3 Codex");
    expect(requireCatalogEntry(result, "openai", "gpt-5.5").name).toBe("GPT-5.5");
  });

  it("keeps OpenAI forward-compat entries on the unified provider", async () => {
    mockAgentDiscoveryModels([
      {
        id: "gpt-5.2",
        provider: "openai",
        name: "GPT-5.2",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.2-pro",
        provider: "openai",
        name: "GPT-5.2 Pro",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-mini",
        provider: "openai",
        name: "GPT-5 mini",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-nano",
        provider: "openai",
        name: "GPT-5 nano",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.4",
        provider: "openai",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const entry = requireCatalogEntry(result, "openai", "gpt-5.4");
    expect(entry.name).toBe("GPT-5.3 Codex");
    expect(
      result.some(
        (entryResult) => entryResult.provider === "openai" && entryResult.id === "gpt-5.4-mini",
      ),
    ).toBe(false);
  });

  it("merges provider-owned supplemental catalog entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "kilocode",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1048576,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const entry = requireCatalogEntry(result, "kilocode", "google/gemini-3.1-pro-preview");
    expect(entry.name).toBe("Gemini 3 Pro Preview");
  });

  it("does not carry capabilities across a supplemental route change", async () => {
    mockAgentDiscoveryModels([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "Platform GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_000_000,
        reasoning: true,
        input: ["text", "image"],
        params: { platformOnly: true },
        compat: { supportsTemperature: false },
      },
    ]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(requireCatalogEntry(result, "openai", "gpt-5.5")).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "ChatGPT GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      compat: undefined,
    });
  });

  it("loads manifest catalog rows from the current metadata snapshot without provider runtime", () => {
    const snapshot = manifestModelCatalogSnapshot({
      id: "external-fast",
      name: "External Fast",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 32000,
    });
    currentPluginMetadataSnapshotMock.mockReturnValue(snapshot);

    const result = loadManifestModelCatalog({ config: {} as OpenClawConfig });

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "External Fast",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 32000,
      },
    ]);
  });

  it("reuses planned manifest catalog rows for the same config and metadata snapshot", () => {
    const config = {} as OpenClawConfig;
    const snapshot = manifestModelCatalogSnapshot({ id: "external-fast" });
    currentPluginMetadataSnapshotMock.mockReturnValue(snapshot);

    const first = loadManifestModelCatalog({ config });
    const second = loadManifestModelCatalog({ config });

    expect(second).toBe(first);
    expect(first).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "external-fast",
        input: ["text"],
        reasoning: false,
      },
    ]);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("refreshes manifest catalog rows when the metadata snapshot changes", () => {
    const config = {} as OpenClawConfig;
    currentPluginMetadataSnapshotMock
      .mockReturnValueOnce(manifestModelCatalogSnapshot({ id: "external-fast" }))
      .mockReturnValue(manifestModelCatalogSnapshot({ id: "external-slow" }));

    const first = loadManifestModelCatalog({ config });
    const second = loadManifestModelCatalog({ config });

    expect(second).not.toBe(first);
    expect(first[0]?.id).toBe("external-fast");
    expect(second[0]?.id).toBe("external-slow");
  });

  it("lets read-only manifest catalog reuse the current workspace-scoped snapshot", () => {
    loadManifestModelCatalog({
      config: {} as OpenClawConfig,
      fallbackToMetadataScan: false,
    });

    const call = requireMockCallParam(currentPluginMetadataSnapshotMock, "current snapshot params");
    expect(call.allowWorkspaceScopedSnapshot).toBe(true);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("passes explicit env when checking current manifest catalog snapshot compatibility", () => {
    const env = { HOME: "/tmp/openclaw-model-catalog-env" } as NodeJS.ProcessEnv;

    loadManifestModelCatalog({
      config: {} as OpenClawConfig,
      env,
      fallbackToMetadataScan: false,
    });

    const call = requireMockCallParam(currentPluginMetadataSnapshotMock, "current snapshot params");
    expect(call.env).toBe(env);
    expect(call.allowWorkspaceScopedSnapshot).toBe(true);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("dedupes supplemental models against registry entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "ollama",
        id: "llama3.2",
        name: "Llama 3.2",
        reasoning: true,
        input: ["text"],
        contextWindow: 1048576,
      },
      {
        provider: "openai",
        id: "gpt-4.1",
        name: "Duplicate GPT-4.1",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(requireCatalogEntry(result, "ollama", "llama3.2").name).toBe("Llama 3.2");
    expect(
      result.filter((entry) => entry.provider === "openai" && entry.id === "gpt-4.1"),
    ).toHaveLength(1);
  });

  it("refreshes discovered rows with provider supplemental catalog metadata", async () => {
    mockAgentDiscoveryModels([
      {
        provider: "github-copilot",
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
      },
    ]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "github-copilot",
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8 Live",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const entry = requireCatalogEntry(result, "github-copilot", "claude-opus-4.8");
    expect(result.filter((entryValue) => entryValue.provider === "github-copilot")).toHaveLength(1);
    expect(entry.name).toBe("Claude Opus 4.8");
    expect(entry.contextWindow).toBe(1_000_000);
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.reasoning).toBe(true);
  });

  it("passes configured provider rows to provider catalog augment hooks", async () => {
    mockAgentDiscoveryModels([]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "ollama",
        id: "minimax-m3:cloud",
        name: "Minimax M3 Live",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        compat: { supportsTools: true },
      },
    ]);

    const result = await loadModelCatalog({
      agentDir: "/tmp/catalog-agent",
      workspaceDir: "/tmp/catalog-workspace",
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [
                {
                  id: "minimax-m3:cloud",
                  name: "Minimax M3 Configured",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  compat: { supportsTools: false },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const entry = requireCatalogEntry(result, "ollama", "minimax-m3:cloud");
    expect(entry.name).toBe("Minimax M3 Live");
    expect(entry.contextWindow).toBe(128_000);
    expect(entry.input).toEqual(["text"]);
    expect(entry.reasoning).toBe(false);
    expect(entry.compat).toEqual({ supportsTools: false });
    expect(augmentCatalogMock.mock.calls[0]?.[0]?.context.entries).toContainEqual(
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        name: "Minimax M3 Configured",
        contextWindow: 128_000,
      }),
    );
    expect(augmentCatalogMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: "/tmp/catalog-workspace",
      context: { agentDir: "/tmp/catalog-agent", workspaceDir: "/tmp/catalog-workspace" },
    });
  });

  it("includes configured provider models missing from discovery", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            modelscope: {
              baseUrl: "https://api-inference.modelscope.cn/v1",
              models: [
                {
                  id: "Qwen/Qwen3.5-35B-A3B",
                  name: "Qwen3.5 35B",
                  input: ["text", "image"],
                  reasoning: true,
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const entry = requireCatalogEntry(result, "modelscope", "Qwen/Qwen3.5-35B-A3B");
    expect(entry.name).toBe("Qwen3.5 35B");
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.reasoning).toBe(true);
    expect(entry.contextWindow).toBe(128_000);
  });

  it("overlays configured model compat onto discovered catalog rows", async () => {
    mockAgentDiscoveryModels([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen3 8B",
        provider: "vllm",
        reasoning: false,
        compat: { supportsStrictMode: false },
      },
    ]);

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://localhost:9000/v1",
              api: "openai-completions",
              models: [
                {
                  id: "vllm/Qwen/Qwen3-8B",
                  name: "Configured Qwen3 8B",
                  compat: { thinkingFormat: "qwen-chat-template" },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    const entry = requireCatalogEntry(result, "vllm", "Qwen/Qwen3-8B");
    expect(result.filter((entryValue) => entryValue.provider === "vllm")).toHaveLength(1);
    expect(entry.name).toBe("Qwen3 8B");
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual(
      expect.objectContaining({
        supportsStrictMode: false,
        thinkingFormat: "qwen-chat-template",
      }),
    );
  });

  it("overlays configured model compat onto persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        providers: {
          vllm: {
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen3 8B",
                reasoning: false,
                compat: { supportsStrictMode: false },
              },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://localhost:9000/v1",
              api: "openai-completions",
              models: [
                {
                  id: "vllm/Qwen/Qwen3-8B",
                  name: "Configured Qwen3 8B",
                  compat: { thinkingFormat: "qwen-chat-template" },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      readOnly: true,
    });

    const entry = requireCatalogEntry(result, "vllm", "Qwen/Qwen3-8B");
    expect(result.filter((entryLocal) => entryLocal.provider === "vllm")).toHaveLength(1);
    expect(entry.name).toBe("Qwen3 8B");
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual(
      expect.objectContaining({
        supportsStrictMode: false,
        thinkingFormat: "qwen-chat-template",
      }),
    );
  });

  it("merges manifest model catalog rows on the normal catalog path", async () => {
    mockSingleOpenAiCatalogModel();
    currentPluginMetadataSnapshotMock.mockReturnValue({
      ...emptyPluginMetadataSnapshot(),
      plugins: [
        {
          id: "byteplus",
          origin: "bundled",
          providers: ["byteplus"],
          modelCatalog: {
            providers: {
              byteplus: {
                baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
                api: "openai-completions",
                models: [
                  {
                    id: "seed-1-8-251228",
                    name: "Doubao Seed 1.8",
                    input: ["text", "image"],
                    contextWindow: 256_000,
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const entry = requireCatalogEntry(result, "byteplus", "seed-1-8-251228");
    expect(entry.name).toBe("Doubao Seed 1.8");
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.contextWindow).toBe(256_000);
  });

  it("refreshes discovered rows with manifest catalog metadata", async () => {
    mockAgentDiscoveryModels([
      {
        provider: "xai",
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
      },
    ]);
    currentPluginMetadataSnapshotMock.mockReturnValue({
      ...emptyPluginMetadataSnapshot(),
      plugins: [
        {
          id: "xai",
          origin: "bundled",
          providers: ["xai"],
          modelCatalog: {
            providers: {
              xai: {
                api: "openai-responses",
                models: [
                  {
                    id: "grok-4.3",
                    name: "Grok 4.3",
                    reasoning: true,
                    input: ["text", "image"],
                    contextWindow: 1_000_000,
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const entry = requireCatalogEntry(result, "xai", "grok-4.3");
    expect(result.filter((entryValue) => entryValue.provider === "xai")).toHaveLength(1);
    expect(entry.api).toBe("openai-responses");
    expect(entry.contextWindow).toBe(1_000_000);
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.reasoning).toBe(true);
  });

  it("keeps configured LM Studio models visible without runtime catalog augmentation", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([]);

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://127.0.0.1:1234/v1",
              models: [
                {
                  id: "qwen3.6-27b@iq3_xxs",
                  name: "Qwen 3.6 27B",
                  input: ["text"],
                  reasoning: false,
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const entry = requireCatalogEntry(result, "lmstudio", "qwen3.6-27b@iq3_xxs");
    expect(entry.name).toBe("Qwen 3.6 27B");
    expect(entry.contextWindow).toBe(128_000);
  });

  it("dedupes configured models without rewriting provider ids", async () => {
    mockAgentDiscoveryModels([{ id: "glm-5", provider: "z.ai", name: "GLM-5" }]);

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            "z-ai": {
              baseUrl: "https://api.z.ai/v1",
              models: [
                {
                  id: "glm-5",
                  name: "Configured GLM-5",
                  input: ["text", "image"],
                  reasoning: false,
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const matches = result.filter((entry) => findModelInCatalog([entry], "z-ai", "glm-5"));
    expect(matches).toHaveLength(1);
    const match = matches[0];
    expect(match?.provider).toBe("z-ai");
    expect(match?.id).toBe("glm-5");
    expect(match?.name).toBe("Configured GLM-5");
  });

  it("does not add unrelated models when provider plugins return nothing", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(
      result.some((entry) => entry.provider === "qianfan" && entry.id === "deepseek-v3.2"),
    ).toBe(false);
  });

  it("does not duplicate provider-owned supplemental models already present in ModelRegistry", async () => {
    mockAgentDiscoveryModels([
      {
        id: "kilo/auto",
        provider: "kilocode",
        name: "Kilo Auto",
      },
    ]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "kilocode",
        id: "kilo/auto",
        name: "Configured Kilo Auto",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const matches = result.filter(
      (entry) => entry.provider === "kilocode" && entry.id === "kilo/auto",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Kilo Auto");
  });

  it("does not match models across provider id variants", () => {
    expect(
      findModelInCatalog([{ provider: "z.ai", id: "glm-5", name: "GLM-5" }], "z-ai", "glm-5"),
    ).toBeUndefined();
  });

  it("resolves catalog entries with explicit providers and unique providerless matches", () => {
    const catalog = [
      { provider: "first", id: "shared", name: "First", input: ["text"] },
      { provider: "second", id: "shared", name: "Second", input: ["text", "image"] },
      { provider: "modelscope", id: "qwen/qwen3.5-35b-a3b", name: "Qwen", input: ["text"] },
    ] satisfies Awaited<ReturnType<typeof loadModelCatalog>>;

    expect(findModelCatalogEntry(catalog, { provider: "second", modelId: "SHARED" })).toEqual(
      catalog[1],
    );
    expect(
      findModelCatalogEntry(catalog, { provider: "modelscope", modelId: "Qwen/Qwen3.5-35B-A3B" }),
    ).toEqual(catalog[2]);
    expect(findModelCatalogEntry(catalog, { modelId: "shared" })).toBeUndefined();
    expect(findModelCatalogEntry(catalog, { modelId: "Qwen/Qwen3.5-35B-A3B" })).toEqual(catalog[2]);
    expect(modelSupportsInput(catalog[1], "image")).toBe(true);
    expect(modelSupportsInput(catalog[2], "image")).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
