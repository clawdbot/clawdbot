import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMemoryWikiMutation,
  normalizeMemoryWikiMutationInput,
  type ApplyMemoryWikiMutation,
} from "./apply.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { listMemoryWikiImportInsights } from "./import-insights.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { listMemoryWikiPalace } from "./memory-palace.js";
import { searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { resolveMemoryWikiStatus } from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./apply.js", () => ({
  applyMemoryWikiMutation: vi.fn(),
  normalizeMemoryWikiMutationInput: vi.fn(),
}));

vi.mock("./compile.js", () => ({
  compileMemoryWikiVault: vi.fn(),
}));

vi.mock("./ingest.js", () => ({
  ingestMemoryWikiSource: vi.fn(),
}));

vi.mock("./import-insights.js", () => ({
  listMemoryWikiImportInsights: vi.fn(),
}));

vi.mock("./import-runs.js", () => ({
  listMemoryWikiImportRuns: vi.fn(),
}));

vi.mock("./lint.js", () => ({
  lintMemoryWikiVault: vi.fn(),
}));

vi.mock("./memory-palace.js", () => ({
  listMemoryWikiPalace: vi.fn(),
}));

vi.mock("./obsidian.js", () => ({
  probeObsidianCli: vi.fn(),
  runObsidianCommand: vi.fn(),
  runObsidianDaily: vi.fn(),
  runObsidianOpen: vi.fn(),
  runObsidianSearch: vi.fn(),
}));

vi.mock("./query.js", () => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
  WIKI_SEARCH_MODES: ["auto", "find-person", "route-question", "source-evidence", "raw-claim"],
}));

vi.mock("./source-sync.js", () => ({
  syncMemoryWikiImportedSources: vi.fn(),
}));

vi.mock("./status.js", () => ({
  buildMemoryWikiDoctorReport: vi.fn(),
  resolveMemoryWikiStatus: vi.fn(),
}));

vi.mock("./vault.js", () => ({
  initializeMemoryWikiVault: vi.fn(),
}));

const { createPluginApi, createVault } = createMemoryWikiTestHarness();

function findGatewayHandler(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
):
  | ((ctx: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
    }) => Promise<void>)
  | undefined {
  return registerGatewayMethod.mock.calls.find((call) => call[0] === method)?.[1];
}

function readGatewayMethodOptions(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
): unknown {
  return registerGatewayMethod.mock.calls.find((call) => call[0] === method)?.[2];
}

function readRespondPayload(respond: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const call = respond.mock.calls[0];
  expect(call?.[0]).toBe(true);
  return call?.[1];
}

function readRespondError(respond: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const call = respond.mock.calls[0];
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  return call?.[2];
}

describe("memory-wiki gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncMemoryWikiImportedSources).mockResolvedValue({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
      indexesRefreshed: false,
      indexUpdatedFiles: [],
      indexRefreshReason: "no-import-changes",
    });
    vi.mocked(resolveMemoryWikiStatus).mockResolvedValue({
      vaultMode: "isolated",
      vaultExists: true,
    } as never);
    vi.mocked(ingestMemoryWikiSource).mockResolvedValue({
      pagePath: "sources/alpha-notes.md",
    } as never);
    vi.mocked(listMemoryWikiImportRuns).mockResolvedValue({
      runs: [],
      totalRuns: 0,
      activeRuns: 0,
      rolledBackRuns: 0,
    } as never);
    vi.mocked(listMemoryWikiImportInsights).mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 0,
      totalClusters: 0,
      clusters: [],
    } as never);
    vi.mocked(listMemoryWikiPalace).mockResolvedValue({
      totalItems: 0,
      totalClaims: 0,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [],
    } as never);
    vi.mocked(normalizeMemoryWikiMutationInput).mockReturnValue({
      op: "create_synthesis",
      title: "Gateway Alpha",
      body: "Gateway summary.",
      sourceIds: ["source.alpha"],
    } satisfies ApplyMemoryWikiMutation);
    vi.mocked(applyMemoryWikiMutation).mockResolvedValue({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    } as never);
    vi.mocked(searchMemoryWiki).mockResolvedValue({
      items: [],
      total: 0,
    } as never);
  });

  it("registers Obsidian CLI methods with write scope", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });

    expect(
      Object.fromEntries(
        registerGatewayMethod.mock.calls
          .filter(([method]) => typeof method === "string" && method.startsWith("wiki.obsidian."))
          .map(([method, , options]) => [method, options]),
      ),
    ).toEqual({
      "wiki.obsidian.status": { scope: "operator.read" },
      "wiki.obsidian.search": { scope: "operator.write" },
      "wiki.obsidian.open": { scope: "operator.write" },
      "wiki.obsidian.command": { scope: "operator.write" },
      "wiki.obsidian.daily": { scope: "operator.write" },
    });
  });

  it("returns wiki status over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.status");
    if (!handler) {
      throw new Error("wiki.status handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: undefined });
    expect(resolveMemoryWikiStatus).toHaveBeenCalledWith(config, {
      appConfig: undefined,
    });
    expect(readRespondPayload(respond)).toEqual({
      vaultMode: "isolated",
      vaultExists: true,
    });
  });

  it("returns recent import runs over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();
    vi.mocked(listMemoryWikiImportRuns).mockResolvedValue({
      runs: [
        {
          runId: "chatgpt-abc123",
          importType: "chatgpt",
          appliedAt: "2026-04-10T10:00:00.000Z",
          exportPath: "/tmp/chatgpt",
          sourcePath: "/tmp/chatgpt/conversations.json",
          conversationCount: 12,
          createdCount: 4,
          updatedCount: 2,
          skippedCount: 6,
          status: "applied",
          pagePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
          samplePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
        },
      ],
      totalRuns: 1,
      activeRuns: 1,
      rolledBackRuns: 0,
    } as never);

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.importRuns");
    if (!handler) {
      throw new Error("wiki.importRuns handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        limit: 5,
      },
      respond,
    });

    expect(listMemoryWikiImportRuns).toHaveBeenCalledWith(config, { limit: 5 });
    expect(readRespondPayload(respond)).toEqual({
      runs: [
        {
          runId: "chatgpt-abc123",
          importType: "chatgpt",
          appliedAt: "2026-04-10T10:00:00.000Z",
          exportPath: "/tmp/chatgpt",
          sourcePath: "/tmp/chatgpt/conversations.json",
          conversationCount: 12,
          createdCount: 4,
          updatedCount: 2,
          skippedCount: 6,
          status: "applied",
          pagePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
          samplePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
        },
      ],
      totalRuns: 1,
      activeRuns: 1,
      rolledBackRuns: 0,
    });
  });

  it("returns import insights over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();
    vi.mocked(listMemoryWikiImportInsights).mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 1,
      clusters: [
        {
          key: "topic/travel",
          label: "Travel",
          itemCount: 2,
          highRiskCount: 1,
          withheldCount: 1,
          preferenceSignalCount: 0,
          updatedAt: "2026-04-10T10:00:00.000Z",
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-alpha.md",
              title: "BA flight receipts process",
              riskLevel: "low",
              labels: ["domain/personal", "area/travel", "topic/travel"],
              topicKey: "topic/travel",
              topicLabel: "Travel",
              digestStatus: "available",
              firstUserLine: "how do i get receipts?",
              lastUserLine: "that option does not exist",
              preferenceSignals: [],
            },
          ],
        },
      ],
    } as never);

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.importInsights");
    if (!handler) {
      throw new Error("wiki.importInsights handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: undefined });
    expect(listMemoryWikiImportInsights).toHaveBeenCalledWith(config);
    expect(readRespondPayload(respond)).toEqual({
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 1,
      clusters: [
        {
          key: "topic/travel",
          label: "Travel",
          itemCount: 2,
          highRiskCount: 1,
          withheldCount: 1,
          preferenceSignalCount: 0,
          updatedAt: "2026-04-10T10:00:00.000Z",
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-alpha.md",
              title: "BA flight receipts process",
              riskLevel: "low",
              labels: ["domain/personal", "area/travel", "topic/travel"],
              topicKey: "topic/travel",
              topicLabel: "Travel",
              digestStatus: "available",
              firstUserLine: "how do i get receipts?",
              lastUserLine: "that option does not exist",
              preferenceSignals: [],
            },
          ],
        },
      ],
    });
  });

  it("returns memory palace overview over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();
    vi.mocked(listMemoryWikiPalace).mockResolvedValue({
      totalItems: 3,
      totalClaims: 4,
      totalQuestions: 1,
      totalContradictions: 1,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 0,
          items: [
            {
              pagePath: "syntheses/travel-system.md",
              title: "Travel system",
              kind: "synthesis",
              claimCount: 2,
              questionCount: 1,
              contradictionCount: 0,
              claims: ["prefers direct receipts"],
              questions: ["should this become a playbook?"],
              contradictions: [],
            },
          ],
        },
      ],
    } as never);

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.palace");
    if (!handler) {
      throw new Error("wiki.palace handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: undefined });
    expect(listMemoryWikiPalace).toHaveBeenCalledWith(config);
    expect(readRespondPayload(respond)).toEqual({
      totalItems: 3,
      totalClaims: 4,
      totalQuestions: 1,
      totalContradictions: 1,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 0,
          items: [
            {
              pagePath: "syntheses/travel-system.md",
              title: "Travel system",
              kind: "synthesis",
              claimCount: 2,
              questionCount: 1,
              contradictionCount: 0,
              claims: ["prefers direct receipts"],
              questions: ["should this become a playbook?"],
              contradictions: [],
            },
          ],
        },
      ],
    });
  });

  it("validates required query params for wiki.search", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.search");
    if (!handler) {
      throw new Error("wiki.search handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(searchMemoryWiki).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({
      code: "internal_error",
      message: "query is required.",
    });
  });

  it("forwards wiki.search mode and corpus options over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.search");
    if (!handler) {
      throw new Error("wiki.search handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        query: "Teams Azure",
        maxResults: 3,
        corpus: "wiki",
        backend: "local",
        mode: "route-question",
      },
      respond,
    });

    expect(searchMemoryWiki).toHaveBeenCalledWith({
      config,
      appConfig: undefined,
      query: "Teams Azure",
      maxResults: 3,
      searchBackend: "local",
      searchCorpus: "wiki",
      mode: "route-question",
    });
    expect(readRespondPayload(respond)).toEqual({
      items: [],
      total: 0,
    });
  });

  it("passes the default agent scope to shared wiki.search gateway calls", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();
    const appConfig = {
      agents: {
        list: [{ id: "main", default: true }],
      },
    };

    registerMemoryWikiGatewayMethods({ api, config, appConfig });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.search");
    if (!handler) {
      throw new Error("wiki.search handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        query: "sessions",
        corpus: "memory",
        backend: "shared",
      },
      respond,
    });

    expect(searchMemoryWiki).toHaveBeenCalledWith({
      config,
      appConfig,
      agentId: "main",
      query: "sessions",
      maxResults: undefined,
      searchBackend: "shared",
      searchCorpus: "memory",
      mode: undefined,
    });
  });

  it("registers wiki.ingest with admin scope and keeps compile at write scope", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });

    expect(readGatewayMethodOptions(registerGatewayMethod, "wiki.compile")).toEqual({
      scope: "operator.write",
    });
    expect(readGatewayMethodOptions(registerGatewayMethod, "wiki.ingest")).toEqual({
      scope: "operator.admin",
    });
  });

  it("forwards ingest requests over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.ingest");
    if (!handler) {
      throw new Error("wiki.ingest handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        inputPath: "/tmp/alpha-notes.txt",
        title: "Alpha",
      },
      respond,
    });

    expect(ingestMemoryWikiSource).toHaveBeenCalledWith({
      config,
      inputPath: "/tmp/alpha-notes.txt",
      title: "Alpha",
    });
    expect(readRespondPayload(respond)).toEqual({
      pagePath: "sources/alpha-notes.md",
    });
  });

  it("applies wiki mutations over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.apply");
    if (!handler) {
      throw new Error("wiki.apply handler missing");
    }
    const respond = vi.fn();
    const params = {
      op: "create_synthesis",
      title: "Gateway Alpha",
      body: "Gateway summary.",
      sourceIds: ["source.alpha"],
    };

    await handler({
      params,
      respond,
    });

    expect(normalizeMemoryWikiMutationInput).toHaveBeenCalledWith(params);
    expect(applyMemoryWikiMutation).toHaveBeenCalledWith({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Gateway Alpha",
        body: "Gateway summary.",
        sourceIds: ["source.alpha"],
      },
    });
    expect(readRespondPayload(respond)).toEqual({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    });
  });
});
