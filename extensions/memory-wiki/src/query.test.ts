import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { getActiveMemorySearchManagerMock, resolveDefaultAgentIdMock, resolveSessionAgentIdMock } =
  vi.hoisted(() => ({
    getActiveMemorySearchManagerMock: vi.fn(),
    resolveDefaultAgentIdMock: vi.fn(() => "main"),
    resolveSessionAgentIdMock: vi.fn(({ sessionKey }: { sessionKey?: string }) =>
      sessionKey === "agent:secondary:thread" ? "secondary" : "main",
    ),
  }));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

beforeEach(() => {
  getActiveMemorySearchManagerMock.mockReset();
  getActiveMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "unavailable" });
  resolveDefaultAgentIdMock.mockClear();
  resolveSessionAgentIdMock.mockClear();
});

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-query-suite-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
});

async function createQueryVault(options?: {
  config?: MemoryWikiPluginConfig;
  initialize?: boolean;
}) {
  return createVault({
    prefix: "memory-wiki-query-",
    rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
    initialize: options?.initialize,
    config: options?.config,
  });
}

function createAppConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

function createMemoryManager(overrides?: {
  searchResults?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: "memory" | "sessions";
    citation?: string;
  }>;
  readResult?: { text: string; path: string };
}) {
  return {
    search: vi.fn().mockResolvedValue(overrides?.searchResults ?? []),
    readFile: vi.fn().mockImplementation(async () => {
      if (!overrides?.readResult) {
        throw new Error("missing");
      }
      return overrides.readResult;
    }),
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    probeVectorAvailability: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("searchMemoryWiki", () => {
  it("finds wiki pages by title and body", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha body text\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]?.corpus).toBe("wiki");
    expect(results[0]?.path).toBe("sources/alpha.md");
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("does not match generated related blocks during wiki search", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
        },
        body: [
          "# Alpha",
          "",
          "Alpha body.",
          "",
          "## Related",
          "<!-- openclaw:wiki:related:start -->",
          "### Related Pages",
          "- [Needle Person](entities/needle-person.md)",
          "<!-- openclaw:wiki:related:end -->",
          "",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "needle-person.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.needle-person",
          title: "Needle Person",
          sourceIds: ["source.alpha"],
        },
        body: "# Needle Person\n\nNeedle body.\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({
      config,
      query: "Needle Person",
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual(["entities/needle-person.md"]);
  });

  it("matches pages when all query terms appear without an exact phrase", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "brad.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.brad",
          title: "Maintainer: Brad Groux",
          sourceIds: ["source.maintainers"],
        },
        body: [
          "# Maintainer: Brad Groux",
          "",
          "## Agent Card",
          "- Maintainer lane: CEO; Microsoft-facing OpenClaw maintainer",
          "",
          "## AI Notes",
          "- Main sample theme is Microsoft ecosystem adoption: Teams, M365, Azure, Foundry, tenants, and pilots.",
          "",
        ].join("\n"),
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({
      config,
      query: "Brad Microsoft Teams",
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual(["entities/brad.md"]);
    expect(results[0]?.snippet).toContain("Teams");
  });

  it("supports people-routing search modes and claim evidence drilldown metadata", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "brad.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          entityType: "person",
          id: "entity.brad",
          title: "Brad Groux",
          canonicalId: "maintainer.brad-groux",
          aliases: ["bgroux"],
          privacyTier: "local-private",
          personCard: {
            handles: ["@bgroux"],
            lane: "Microsoft Teams",
            askFor: ["Teams and Azure rollout questions"],
          },
          bestUsedFor: ["Microsoft ecosystem routing"],
          relationships: [
            {
              targetId: "entity.alice",
              targetTitle: "Alice",
              kind: "works-with",
              note: "Teams escalation buddy",
            },
          ],
          claims: [
            {
              id: "claim.brad.teams",
              text: "Brad is a strong route for Microsoft Teams questions.",
              status: "supported",
              confidence: 0.88,
              evidence: [
                {
                  kind: "maintainer-whois",
                  sourceId: "source.maintainers",
                  privacyTier: "local-private",
                },
              ],
            },
          ],
        },
        body: "# Brad Groux\n\nAgent card summary.\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "maintainers.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.maintainers",
          title: "Maintainers Source",
        },
        body: "# Maintainers Source\n\nmaintainer-whois Teams sample.\n",
      }),
      "utf8",
    );
    await compileMemoryWikiVault(config);

    const personResults = await searchMemoryWiki({
      config,
      query: "bgroux",
      mode: "find-person",
    });
    expect(personResults[0]).toEqual(
      expect.objectContaining({
        path: "entities/brad.md",
        canonicalId: "maintainer.brad-groux",
        aliases: ["bgroux"],
        privacyTier: "local-private",
        searchMode: "find-person",
      }),
    );

    const routeResults = await searchMemoryWiki({
      config,
      query: "who should I ask about Teams?",
      mode: "route-question",
    });
    expect(routeResults[0]?.path).toBe("entities/brad.md");

    const claimResults = await searchMemoryWiki({
      config,
      query: "strong route Teams",
      mode: "raw-claim",
    });
    expect(claimResults[0]).toEqual(
      expect.objectContaining({
        path: "entities/brad.md",
        matchedClaimId: "claim.brad.teams",
        matchedClaimConfidence: 0.88,
        evidenceKinds: ["maintainer-whois"],
        evidenceSourceIds: ["source.maintainers"],
      }),
    );

    const evidenceResults = await searchMemoryWiki({
      config,
      query: "maintainer-whois",
      mode: "source-evidence",
      maxResults: 2,
    });
    expect(evidenceResults.map((result) => result.path)).toContain("sources/maintainers.md");
  });

  it("keeps route-question relationship matches in compiled digest prefilter", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "brad.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          entityType: "person",
          id: "entity.brad",
          title: "Brad Groux",
          relationships: [
            {
              targetId: "entity.alice",
              targetTitle: "Alice",
              kind: "collaborates-with",
              note: "Azure escalation buddy",
            },
          ],
        },
        body: "# Brad Groux\n\nAgent card summary.\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "fallback.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.fallback",
          title: "Fallback Router",
          bestUsedFor: ["Azure escalation buddy"],
        },
        body: "# Fallback Router\n\nGeneric routing note.\n",
      }),
      "utf8",
    );
    await compileMemoryWikiVault(config);

    const routeResults = await searchMemoryWiki({
      config,
      query: "who should I ask about Azure escalation buddy?",
      mode: "route-question",
      maxResults: 1,
    });

    expect(routeResults[0]?.path).toBe("entities/brad.md");
  });

  it("uses body text instead of frontmatter for fallback snippets", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alias.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alias",
          title: "Alias Carrier",
          aliases: ["frontmatter-only-alias"],
          sourceIds: ["source.maintainers"],
        },
        body: "# Alias Carrier\n\nReadable agent card summary.\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({
      config,
      query: "frontmatter-only-alias",
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual(["entities/alias.md"]);
    expect(results[0]?.snippet).toBe("# Alias Carrier");
  });

  it("finds wiki pages by structured claim text and surfaces the claim as the snippet", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.postgres",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              confidence: 0.91,
              evidence: [{ sourceId: "source.alpha", lines: "12-18" }],
            },
          ],
        },
        body: "# Alpha\n\nsummary without the query phrase\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "postgresql" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      corpus: "wiki",
      path: "entities/alpha.md",
      snippet: "Alpha uses PostgreSQL for production writes.",
    });
  });

  it("ranks fresh supported claims ahead of stale contested claims", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha-fresh.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha.fresh",
          title: "Alpha Fresh",
          updatedAt: "2026-04-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db.fresh",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              confidence: 0.91,
              evidence: [
                {
                  sourceId: "source.alpha",
                  lines: "4-7",
                  updatedAt: "2026-04-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha Fresh\n\nsummary without the keyword\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha-stale.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha.stale",
          title: "Alpha Stale",
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db.stale",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "contested",
              confidence: 0.92,
              evidence: [
                {
                  sourceId: "source.alpha.old",
                  lines: "1-2",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha Stale\n\nsummary without the keyword\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "postgresql" });

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("entities/alpha-fresh.md");
    expect(results[1]?.path).toBe("entities/alpha-stale.md");
  });

  it("surfaces bridge provenance for imported source pages", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Bridge Alpha",
          sourceType: "memory-bridge",
          sourcePath: "/tmp/workspace/MEMORY.md",
          bridgeRelativePath: "MEMORY.md",
          bridgeWorkspaceDir: "/tmp/workspace",
          updatedAt: "2026-04-05T12:00:00.000Z",
        },
        body: "# Bridge Alpha\n\nalpha bridge body\n",
      }),
      "utf8",
    );

    const results = await searchMemoryWiki({ config, query: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      corpus: "wiki",
      sourceType: "memory-bridge",
      sourcePath: "/tmp/workspace/MEMORY.md",
      provenanceLabel: "bridge: MEMORY.md",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
  });

  it("includes active memory results when shared search and all corpora are enabled", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "all" },
      },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha body text\n",
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "MEMORY.md",
          startLine: 4,
          endLine: 8,
          score: 42,
          snippet: "alpha durable memory",
          source: "memory",
          citation: "MEMORY.md#L4-L8",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      config,
      appConfig: createAppConfig(),
      query: "alpha",
      maxResults: 5,
    });

    expect(results).toHaveLength(2);
    expect(results.some((result) => result.corpus === "wiki")).toBe(true);
    expect(results.some((result) => result.corpus === "memory")).toBe(true);
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: createAppConfig(),
      agentId: "main",
    });
  });

  it("uses the active session agent for shared memory search", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "memory/2026-04-07.md",
          startLine: 1,
          endLine: 2,
          score: 1,
          snippet: "secondary agent memory",
          source: "memory",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    await searchMemoryWiki({
      config,
      appConfig: createAppConfig(),
      agentSessionKey: "agent:secondary:thread",
      query: "secondary",
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "agent:secondary:thread",
      config: createAppConfig(),
    });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: createAppConfig(),
      agentId: "secondary",
    });
  });

  it("allows per-call corpus overrides without changing config defaults", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "wiki" },
      },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha body text\n",
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "MEMORY.md",
          startLine: 10,
          endLine: 12,
          score: 99,
          snippet: "memory-only alpha",
          source: "memory",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const memoryOnly = await searchMemoryWiki({
      config,
      appConfig: createAppConfig(),
      query: "alpha",
      searchCorpus: "memory",
    });

    expect(memoryOnly).toHaveLength(1);
    expect(memoryOnly[0]?.corpus).toBe("memory");
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 10 });
  });

  it("keeps memory search disabled when the backend is local", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "local", corpus: "all" },
      },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha only wiki\n",
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 50,
          snippet: "alpha memory",
          source: "memory",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      config,
      appConfig: createAppConfig(),
      query: "alpha",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.corpus).toBe("wiki");
    expect(manager.search).not.toHaveBeenCalled();
  });
});

describe("getMemoryWikiPage", () => {
  it("reads wiki pages by relative path and slices line ranges", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nline one\nline two\nline three\n",
      }),
      "utf8",
    );

    const result = await getMemoryWikiPage({
      config,
      lookup: "sources/alpha.md",
      fromLine: 4,
      lineCount: 2,
    });

    expect(result?.corpus).toBe("wiki");
    expect(result?.path).toBe("sources/alpha.md");
    expect(result?.content).toContain("line one");
    expect(result?.content).toContain("line two");
    expect(result?.content).not.toContain("line three");
    expect(result?.totalLines).toBe(7);
    expect(result?.truncated).toBe(true);
  });

  it("resolves compiled claim ids back to the owning page", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              evidence: [{ sourceId: "source.alpha", lines: "1-2" }],
            },
          ],
        },
        body: "# Alpha\n\nline one\nline two\n",
      }),
      "utf8",
    );
    await compileMemoryWikiVault(config);

    const result = await getMemoryWikiPage({
      config,
      lookup: "claim.alpha.db",
    });

    expect(result).toMatchObject({
      corpus: "wiki",
      path: "entities/alpha.md",
      title: "Alpha",
      id: "entity.alpha",
    });
    expect(result?.content).toContain("line one");
  });

  it("returns provenance for imported wiki source pages", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.unsafe.alpha",
          title: "Unsafe Alpha",
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
          sourcePath: "/tmp/private/alpha.md",
          unsafeLocalConfiguredPath: "/tmp/private",
          unsafeLocalRelativePath: "alpha.md",
          updatedAt: "2026-04-05T13:00:00.000Z",
        },
        body: "# Unsafe Alpha\n\nsecret alpha\n",
      }),
      "utf8",
    );

    const result = await getMemoryWikiPage({
      config,
      lookup: "sources/unsafe-alpha.md",
    });

    expect(result).toMatchObject({
      corpus: "wiki",
      path: "sources/unsafe-alpha.md",
      sourceType: "memory-unsafe-local",
      provenanceMode: "unsafe-local",
      sourcePath: "/tmp/private/alpha.md",
      provenanceLabel: "unsafe-local: alpha.md",
      updatedAt: "2026-04-05T13:00:00.000Z",
    });
  });

  it("falls back to active memory reads when memory corpus is selected", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "durable alpha memory\nline two",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      config,
      appConfig: createAppConfig(),
      lookup: "MEMORY.md",
      fromLine: 2,
      lineCount: 2,
    });

    expect(result).toEqual({
      corpus: "memory",
      path: "MEMORY.md",
      title: "MEMORY",
      kind: "memory",
      content: "durable alpha memory\nline two",
      fromLine: 2,
      lineCount: 2,
    });
    expect(manager.readFile).toHaveBeenCalledWith({
      relPath: "MEMORY.md",
      from: 2,
      lines: 2,
    });
  });

  it("uses the active session agent for shared memory reads", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "secondary memory line",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      config,
      appConfig: createAppConfig(),
      agentSessionKey: "agent:secondary:thread",
      lookup: "MEMORY.md",
    });

    expect(result?.corpus).toBe("memory");
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "agent:secondary:thread",
      config: createAppConfig(),
    });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: createAppConfig(),
      agentId: "secondary",
    });
  });

  it("allows per-call get overrides to bypass wiki and force memory fallback", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "wiki" },
      },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "MEMORY.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.memory.shadow", title: "Shadow Memory" },
        body: "# Shadow Memory\n\nwiki copy\n",
      }),
      "utf8",
    );
    const manager = createMemoryManager({
      readResult: {
        path: "MEMORY.md",
        text: "forced memory read",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      config,
      appConfig: createAppConfig(),
      lookup: "MEMORY.md",
      searchCorpus: "memory",
    });

    expect(result?.corpus).toBe("memory");
    expect(result?.content).toBe("forced memory read");
    expect(manager.readFile).toHaveBeenCalled();
  });
});
