import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadManifestCatalogRowsForList: vi.fn(),
  loadStaticManifestCatalogRowsForList: vi.fn(),
  loadPersistedListCatalogEntries: vi.fn(),
  prepareScopedReadOnlyModelCatalog: vi.fn(),
}));

vi.mock("./list.manifest-catalog.js", () => ({
  loadManifestCatalogRowsForList: mocks.loadManifestCatalogRowsForList,
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

vi.mock("./list.persisted-catalog.js", () => ({
  loadPersistedListCatalogEntries: mocks.loadPersistedListCatalogEntries,
}));

vi.mock("../../agents/prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: mocks.prepareScopedReadOnlyModelCatalog,
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
  mocks.loadPersistedListCatalogEntries.mockReturnValue([]);
  mocks.prepareScopedReadOnlyModelCatalog.mockResolvedValue({
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
    expect(mocks.prepareScopedReadOnlyModelCatalog).not.toHaveBeenCalled();
  });

  it("uses runtime manifest rows to enrich configured model ids", async () => {
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
    expect(mocks.prepareScopedReadOnlyModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps static rows in the scoped snapshot", async () => {
    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      providerIds: ["moonshot"],
      configuredKeys: [],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ provider: "moonshot", id: "kimi-k2.6" }),
    ]);
    expect(snapshot.staticEntries).toEqual(snapshot.entries);
    expect(mocks.prepareScopedReadOnlyModelCatalog).not.toHaveBeenCalled();
  });

  it("uses persisted runtime rows and manifest metadata without loading provider runtimes", async () => {
    mocks.loadPersistedListCatalogEntries.mockReturnValueOnce([
      {
        provider: "openai",
        id: "gpt-5.6",
        name: "Account GPT-5.6",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);

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
        contextWindow: 1_050_000,
      }),
    ]);
    expect(snapshot.routeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ api: "openai-chatgpt-responses" }),
        expect.objectContaining({ api: "openai-responses" }),
      ]),
    );
    expect(mocks.prepareScopedReadOnlyModelCatalog).not.toHaveBeenCalled();
  });

  it("does not discover providers whose explicit models are emitted by the configured row source", async () => {
    mocks.loadManifestCatalogRowsForList.mockReturnValueOnce([]);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([]);

    const snapshot = await loadScopedListModelCatalogSnapshot({
      cfg: {
        models: {
          providers: {
            openai: {
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
      providerIds: ["openai"],
      configuredKeys: ["openai/gpt-5.5"],
    });

    expect(snapshot).toEqual({
      entries: [],
      routeVariants: [],
      staticEntries: [],
    });
    expect(mocks.prepareScopedReadOnlyModelCatalog).not.toHaveBeenCalled();
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
      configuredKeys: ["custom/custom-model"],
    });

    expect(mocks.prepareScopedReadOnlyModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      ["custom"],
    );
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
    mocks.prepareScopedReadOnlyModelCatalog.mockResolvedValueOnce({
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
    expect(mocks.prepareScopedReadOnlyModelCatalog).toHaveBeenCalledWith(
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
