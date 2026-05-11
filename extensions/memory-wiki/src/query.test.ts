import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, isSessionMemoryPath, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const {
  getActiveMemorySearchManagerMock,
  loadCombinedSessionStoreForGatewayMock,
  resolveDefaultAgentIdMock,
  resolveSessionAgentIdMock,
} = vi.hoisted(() => ({
  getActiveMemorySearchManagerMock: vi.fn(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
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

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
  };
});

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

function collectWikiResultPaths(results: readonly { corpus: string; path: string }[]): string[] {
  const paths: string[] = [];
  for (const result of results) {
    if (result.corpus === "wiki") {
      paths.push(result.path);
    }
  }
  return paths;
}

function expectFields(value: unknown, expected: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toBe(expectedValue);
  }
  return record;
}

beforeEach(() => {
  getActiveMemorySearchManagerMock.mockReset();
  getActiveMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "unavailable" });
  loadCombinedSessionStoreForGatewayMock.mockReset();
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({ storePath: "(test)", store: {} });
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

function createSessionVisibilityAppConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { sessionToolsVisibility: "all" } },
      list: [{ id: "main", default: true }],
    },
    tools: {
      sessions: { visibility: "self" },
    },
  } as OpenClawConfig;
}

function mockSessionTranscriptStore() {
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(test)",
    store: {
      "agent:main:child-session": {
        sessionId: "child-session",
        updatedAt: 1,
        sessionFile: "/tmp/openclaw/child-session.jsonl",
      },
      "agent:main:sibling-session": {
        sessionId: "sibling-session",
        updatedAt: 2,
        sessionFile: "/tmp/openclaw/sibling-session.jsonl",
      },
    },
  });
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

describe("isSessionMemoryPath", () => {
  it("classifies all current session storage layouts", () => {
    for (const relPath of [
      "sessions/child-session.jsonl",
      "qmd/sessions/child-session.md",
      "qmd/sessions-main/child-session.md",
      "qmd\\sessions-main\\child-session.md",
      "qmd/sessions",
    ]) {
      expect(isSessionMemoryPath(relPath)).toBe(true);
    }

    for (const relPath of [
      "sessionsx/child-session.jsonl",
      "qmd/sessionsxxx",
      "wiki/sessions/foo.md",
      "wiki\\sessions\\foo.md",
    ]) {
      expect(isSessionMemoryPath(relPath)).toBe(false);
    }
  });
});

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
    expect(personResults[0]?.path).toBe("entities/brad.md");
    expect(personResults[0]?.canonicalId).toBe("maintainer.brad-groux");
    expect(personResults[0]?.aliases).toEqual(["bgroux"]);
    expect(personResults[0]?.privacyTier).toBe("local-private");
    expect(personResults[0]?.searchMode).toBe("find-person");

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
    expect(claimResults[0]?.path).toBe("entities/brad.md");
    expect(claimResults[0]?.matchedClaimId).toBe("claim.brad.teams");
    expect(claimResults[0]?.matchedClaimConfidence).toBe(0.88);
    expect(claimResults[0]?.evidenceKinds).toEqual(["maintainer-whois"]);
    expect(claimResults[0]?.evidenceSourceIds).toEqual(["source.maintainers"]);

    const evidenceResults = await searchMemoryWiki({
      config,
      query: "maintainer-whois",
      mode: "source-evidence",
      maxResults: 5,
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
    expectFields(results[0], {
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
    expectFields(results[0], {
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
    expect(results.map((result) => result.corpus).toSorted()).toEqual(["memory", "wiki"]);
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: createAppConfig(),
      agentId: "main",
    });
  });

  it("includes memory results and backfills wiki capacity for all-corpus search", async () => {
    const { rootDir, config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "all" },
      },
    });
    for (const index of [1, 2, 3, 4, 5]) {
      await fs.writeFile(
        path.join(rootDir, "entities", `alpha-${index}.md`),
        renderWikiMarkdown({
          frontmatter: {
            pageType: "entity",
            id: `entity.alpha.${index}`,
            title: `Alpha ${index}`,
          },
          body: `# Alpha ${index}\n\nalpha wiki ${index}\n`,
        }),
        "utf8",
      );
    }
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "MEMORY.md",
          startLine: 4,
          endLine: 8,
          score: 0.9,
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

    expect(results).toHaveLength(5);
    expect(results.map((result) => result.corpus)).toContain("memory");
    expect(collectWikiResultPaths(results)).toEqual([
      "entities/alpha-1.md",
      "entities/alpha-2.md",
      "entities/alpha-3.md",
      "entities/alpha-4.md",
    ]);
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
  });

  it("filters session memory hits outside the caller visibility policy", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "sessions/child-session.jsonl",
          startLine: 1,
          endLine: 2,
          score: 30,
          snippet: "caller transcript",
          source: "sessions",
        },
        {
          path: "qmd/sessions-main/sibling-session.md",
          startLine: 3,
          endLine: 4,
          score: 20,
          snippet: "sibling transcript",
          source: "sessions",
        },
        {
          path: "MEMORY.md",
          startLine: 5,
          endLine: 6,
          score: 10,
          snippet: "durable memory",
          source: "memory",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      config,
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
      query: "transcript",
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual([
      "sessions/child-session.jsonl",
      "MEMORY.md",
    ]);
  });

  it("filters session memory hits for session-bound non-sandboxed callers", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      searchResults: [
        {
          path: "sessions/child-session.jsonl",
          startLine: 1,
          endLine: 2,
          score: 30,
          snippet: "caller transcript",
          source: "sessions",
        },
        {
          path: "qmd/sessions-main/sibling-session.md",
          startLine: 3,
          endLine: 4,
          score: 20,
          snippet: "sibling transcript",
          source: "sessions",
        },
        {
          path: "MEMORY.md",
          startLine: 5,
          endLine: 6,
          score: 10,
          snippet: "durable memory",
          source: "memory",
        },
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchMemoryWiki({
      config,
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: false,
      query: "transcript",
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual([
      "sessions/child-session.jsonl",
      "MEMORY.md",
    ]);
  });

  it("requires appConfig for session-bound shared memory searches", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });

    await expect(
      searchMemoryWiki({
        config,
        agentSessionKey: "agent:main:child-session",
        sandboxed: true,
        query: "transcript",
      }),
    ).rejects.toThrow(/wiki_search requires appConfig/);
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

    expectFields(result, {
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

    expectFields(result, {
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

  it("skips session memory reads outside the caller visibility policy", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      readResult: {
        path: "qmd/sessions-main/sibling-session.md",
        text: "sibling transcript content",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      config,
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
      lookup: "qmd/sessions-main/sibling-session.md",
    });

    expect(result).toBeNull();
    expect(manager.readFile).not.toHaveBeenCalled();
  });

  it("permits session memory reads inside the caller visibility policy", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      readResult: {
        path: "qmd/sessions-main/child-session.md",
        text: "own transcript content",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const result = await getMemoryWikiPage({
      config,
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
      lookup: "qmd/sessions-main/child-session.md",
    });

    expectFields(result, {
      corpus: "memory",
      path: "qmd/sessions-main/child-session.md",
      content: "own transcript content",
    });
    expect(manager.readFile).toHaveBeenCalledTimes(1);
    expect(manager.readFile).toHaveBeenCalledWith({
      relPath: "qmd/sessions-main/child-session.md",
      from: 1,
      lines: 200,
    });
  });

  it("requires appConfig for session-bound shared memory reads", async () => {
    const { config } = await createQueryVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "memory" },
      },
    });

    await expect(
      getMemoryWikiPage({
        config,
        agentSessionKey: "agent:main:child-session",
        sandboxed: true,
        lookup: "sessions/child-session.jsonl",
      }),
    ).rejects.toThrow(/wiki_get requires appConfig/);
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
