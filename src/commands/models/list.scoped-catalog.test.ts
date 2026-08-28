import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadManifestCatalogRowsForList: vi.fn(),
  loadStaticManifestCatalogRowsForList: vi.fn(),
  resolveManifestCatalogCoverageForList: vi.fn(),
  loadPersistedListCatalogEntries: vi.fn(),
  prepareScopedReadOnlyLiveModelCatalog: vi.fn(),
}));

vi.mock("./list.manifest-catalog.js", () => ({
  loadManifestCatalogRowsForList: mocks.loadManifestCatalogRowsForList,
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
  resolveManifestCatalogCoverageForList: mocks.resolveManifestCatalogCoverageForList,
}));

vi.mock("./list.persisted-catalog.js", () => ({
  loadPersistedListCatalogEntries: mocks.loadPersistedListCatalogEntries,
}));

vi.mock("../../agents/prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyLiveModelCatalog: mocks.prepareScopedReadOnlyLiveModelCatalog,
}));

import { loadScopedListModelCatalogSnapshot } from "./list.scoped-catalog.js";

const runtimeRow = {
  provider: "openai",
  id: "gpt-5.6",
  ref: "openai/gpt-5.6",
  mergeKey: "openai::gpt-5.6",
  name: "GPT-5.6",
  source: "manifest" as const,
  input: ["text", "image"] as const,
  reasoning: true,
  status: "available" as const,
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_050_000,
};

const staticRow = {
  provider: "moonshot",
  id: "kimi-k2.6",
  ref: "moonshot/kimi-k2.6",
  mergeKey: "moonshot::kimi-k2.6",
  name: "Kimi K2.6",
  source: "manifest" as const,
  input: ["text"] as const,
  reasoning: false,
  status: "available" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadManifestCatalogRowsForList.mockReturnValue([runtimeRow, staticRow]);
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([staticRow]);
  mocks.resolveManifestCatalogCoverageForList.mockReturnValue({
    ownedProviderIds: new Set(),
    completeProviderIds: new Set(),
  });
  mocks.loadPersistedListCatalogEntries.mockReturnValue([]);
  mocks.prepareScopedReadOnlyLiveModelCatalog.mockResolvedValue({
    entries: [],
    routeVariants: [],
  });
});

describe("loadScopedListModelCatalogSnapshot", () => {
  it("returns an empty snapshot without loading catalog sources for an empty scope", async () => {
    await expect(
      loadScopedListModelCatalogSnapshot({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        providerIds: [],
        configuredKeys: [],
      }),
    ).resolves.toEqual({
      entries: [],
      routeVariants: [],
      staticEntries: [],
    });
    expect(mocks.loadManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.loadPersistedListCatalogEntries).not.toHaveBeenCalled();
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).not.toHaveBeenCalled();
  });

  it("uses runtime manifest rows as seeds while retaining live provider discovery", async () => {
    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["openai"],
      configuredKeys: ["openai/gpt-5.6"],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.6",
        api: "openai-responses",
        contextWindow: 1_050_000,
      }),
    ]);
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
    expect(snapshot.staticEntries).toEqual([]);
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["openai"],
    );
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty(
      "inheritedAuthDir",
    );
  });

  it("uses authenticated manifest fallback rows without loading provider runtime", async () => {
    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["openai"],
      runtimeProviderIds: [],
      manifestFallbackProviderIds: ["openai"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.6",
        api: "openai-responses",
        contextWindow: 1_050_000,
      }),
    ]);
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
    expect(snapshot.staticEntries).toEqual([]);
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps static rows in the scoped snapshot", async () => {
    const row = {
      ...staticRow,
      contextTokens: 200_000,
      contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
      contextWindowDefault: "200k",
      thinkingLevelMap: { off: null, high: "high" },
      mediaInput: { image: { maxBytes: 4096 } },
      headers: { "x-provider": "private-transport" },
    };
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([row]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([row]);
    mocks.resolveManifestCatalogCoverageForList.mockReturnValueOnce({
      ownedProviderIds: new Set(["moonshot"]),
      completeProviderIds: new Set(["moonshot"]),
    });
    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["moonshot"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "moonshot",
        id: "kimi-k2.6",
        contextWindow: 200_000,
        contextTokens: 200_000,
        contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
        contextWindowDefault: "200k",
        thinkingLevelMap: { off: null, high: "high" },
        mediaInput: { image: { maxBytes: 4096 } },
      }),
    ]);
    expect(snapshot.entries[0]).not.toHaveProperty("headers");
    expect(snapshot.entries[0]?.contextWindows?.[0]).not.toBe(row.contextWindows[0]);
    expect(snapshot.entries[0]?.thinkingLevelMap).not.toBe(row.thinkingLevelMap);
    expect(snapshot.staticEntries).toEqual(snapshot.entries);
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps persisted rows as seeds while adding runtime-only models", async () => {
    mocks.loadPersistedListCatalogEntries.mockReturnValueOnce([
      {
        provider: "openai",
        id: "gpt-5.6",
        name: "Account GPT-5.6",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 64_000,
      },
    ]);
    mocks.prepareScopedReadOnlyLiveModelCatalog.mockResolvedValueOnce({
      entries: [
        {
          provider: "openai",
          id: "gpt-runtime-only",
          name: "Runtime-only GPT",
          api: "openai-responses",
        },
      ],
      routeVariants: [],
    });

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["openai"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.6",
        name: "Account GPT-5.6",
        api: "openai-chatgpt-responses",
        contextWindow: 64_000,
      }),
      expect.objectContaining({
        provider: "openai",
        id: "gpt-runtime-only",
      }),
    ]);
    expect(snapshot.routeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ api: "openai-chatgpt-responses" }),
        expect.objectContaining({ api: "openai-responses" }),
      ]),
    );
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["openai"],
    );
  });

  it.each([
    { api: runtimeRow.api, baseUrl: "https://other.example/v1", matches: false },
    { api: "openai-completions", baseUrl: runtimeRow.baseUrl, matches: false },
    { api: runtimeRow.api, baseUrl: "https://api.openai.com/v1/", matches: true },
  ])(
    "enriches persisted capabilities only for a matching route: $api $baseUrl",
    async ({ api, baseUrl, matches }) => {
      const persisted = {
        provider: "openai",
        id: runtimeRow.id,
        name: "Account model",
        api,
        baseUrl,
      };
      mocks.loadPersistedListCatalogEntries.mockReturnValueOnce([persisted]);
      const snapshot = await loadScopedListModelCatalogSnapshot({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        providerIds: ["openai"],
        runtimeProviderIds: [],
        configuredKeys: [],
      });

      expect(snapshot.entries[0]?.contextWindow).toBe(matches ? 1_050_000 : undefined);
      expect(snapshot.entries[0]?.reasoning).toBe(matches ? true : undefined);
      expect(snapshot.entries[0]).toMatchObject(persisted);
    },
  );

  it("does not discover unowned providers whose explicit models are emitted by the configured row source", async () => {
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "http://127.0.0.1:3000/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["custom"],
      configuredKeys: ["custom/gpt-5.5"],
    });

    expect(snapshot).toEqual({
      entries: [],
      routeVariants: [],
      staticEntries: [],
    });
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).not.toHaveBeenCalled();
  });

  it("still discovers owned providers when explicit config contains only part of the catalog", async () => {
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.resolveManifestCatalogCoverageForList.mockReturnValueOnce({
      ownedProviderIds: new Set(["openai"]),
      completeProviderIds: new Set(),
    });
    mocks.prepareScopedReadOnlyLiveModelCatalog.mockResolvedValueOnce({
      entries: [
        {
          provider: "openai",
          id: "gpt-runtime-only",
          name: "Runtime-only GPT",
          api: "openai-responses",
        },
      ],
      routeVariants: [],
    });

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-configured",
                  name: "Configured GPT",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["openai"],
      runtimeProviderIds: ["openai"],
      configuredKeys: ["openai/gpt-configured"],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-runtime-only" }),
    ]);
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["openai"],
    );
  });

  it("runtime-augments partial static catalogs instead of hiding runtime-only rows", async () => {
    mocks.resolveManifestCatalogCoverageForList.mockReturnValueOnce({
      ownedProviderIds: new Set(["moonshot"]),
      completeProviderIds: new Set(),
    });
    mocks.prepareScopedReadOnlyLiveModelCatalog.mockResolvedValueOnce({
      entries: [
        {
          provider: "moonshot",
          id: "kimi-runtime-only",
          name: "Runtime-only Kimi",
          api: "openai-completions",
        },
      ],
      routeVariants: [],
    });

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["moonshot"],
      runtimeProviderIds: ["moonshot"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "moonshot", id: "kimi-k2.6" }),
        expect.objectContaining({ provider: "moonshot", id: "kimi-runtime-only" }),
      ]),
    );
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["moonshot"],
    );
  });

  it("still discovers configured providers without a listable API route", async () => {
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);

    await loadScopedListModelCatalogSnapshot({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "http://127.0.0.1:3000/v1",
              models: [
                {
                  id: "custom-model",
                  name: "Custom Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["custom"],
      runtimeProviderIds: ["custom"],
      configuredKeys: ["custom/custom-model"],
    });

    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["custom"],
    );
  });

  it("does not runtime-discover providers included only to enrich configured refs", async () => {
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["google-antigravity"],
      runtimeProviderIds: [],
      configuredKeys: ["google-antigravity/claude-opus-4-6-thinking"],
    });

    expect(snapshot).toEqual({
      entries: [],
      routeVariants: [],
      staticEntries: [],
    });
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).not.toHaveBeenCalled();
  });

  it("falls back to scoped provider discovery only for providers with no lightweight rows", async () => {
    const discovered = {
      provider: "google",
      id: "gemini-live",
      name: "Gemini Live",
      api: "google-generative-ai" as const,
    };
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.prepareScopedReadOnlyLiveModelCatalog.mockResolvedValueOnce({
      entries: [discovered],
      routeVariants: [discovered],
    });

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      inheritedAuthDir: "/tmp/openclaw-default",
      workspaceDir: "/tmp/openclaw-workspace",
      providerIds: ["google"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual([discovered]);
    expect(mocks.prepareScopedReadOnlyLiveModelCatalog).toHaveBeenCalledWith(
      {
        config: {},
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        inheritedAuthDir: "/tmp/openclaw-default",
        workspaceDir: "/tmp/openclaw-workspace",
        readOnly: true,
      },
      ["google"],
    );
  });
});
