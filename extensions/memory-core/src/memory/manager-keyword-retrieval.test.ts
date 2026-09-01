// Memory Core tests cover manager keyword retrieval behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFtsSessionManager,
    getPersistentManager,
    requireManager,
    resetManager: resetManagerForTest,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
    trackManager,
  } = fixture;

  it("builds FTS index and returns search results when no embedding provider is available", async () => {
    providerFixture.forceNoProvider = true;

    const cfg = createCfg({
      provider: "none",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(providerFixture.embedBatchCalls).toBe(0);

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/Alpha/i);

    const noResults = await manager.search("nonexistent_xyz_keyword");
    expect(noResults.length).toBe(0);
  });

  it.each([
    {
      name: "slug path stem",
      config: { hybrid: { enabled: true } },
      exactFile: "project-lantern.md",
      bodyText: "Project lantern project lantern project lantern.",
      query: "project-lantern",
      expectedPath: "memory/project-lantern.md",
    },
    {
      name: "dated path stem",
      config: {},
      exactFile: "2020-01-01.md",
      bodyText: "2020 01 01 2020 01 01 2020 01 01",
      query: "2020-01-01",
      expectedPath: "memory/2020-01-01.md",
    },
  ])("ranks an exact $name ahead of a body match", async (testCase) => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0.35,
      ...testCase.config,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(fixture.paths.memory, testCase.exactFile),
      "Unrelated exact-path body.",
    );
    await fs.writeFile(path.join(fixture.paths.memory, "body-match.md"), testCase.bodyText);
    await manager.sync({ reason: "test" });

    const results = await manager.search(testCase.query, { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain(testCase.expectedPath);
    expect(results[0]?.score).toBe(1);
  });

  it("does not let fallback-term filenames consume the candidate cap", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    for (let index = 0; index < 5; index += 1) {
      const duplicateDir = path.join(fixture.paths.memory, `alpha-${index}`);
      await fs.mkdir(duplicateDir, { recursive: true });
      await fs.writeFile(path.join(duplicateDir, "alpha.md"), "Unrelated path-only candidate.");
    }
    await fs.writeFile(
      path.join(fixture.paths.memory, "body-match.md"),
      "Alpha alpha alpha alpha alpha strongest fallback body match.",
    );
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha gamma", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/body-match.md");
  });

  it("bounds the merged six-term fallback candidate set", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, hybrid: { enabled: true } }),
    );
    const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const term of terms) {
      for (let index = 0; index < 5; index += 1) {
        await fs.writeFile(
          path.join(fixture.paths.memory, `${term}-${index}.md`),
          `${term} body ${index}`,
        );
      }
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search(terms.join(" "), { maxResults: 4, minScore: 0 });

    expect(results).toHaveLength(4);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(4);
  });

  it("counts exact candidate headroom by distinct path instead of chunk", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, hybrid: { enabled: true } }),
    );
    for (let index = 0; index < 200; index += 1) {
      const dir = path.join(fixture.paths.memory, index.toString().padStart(3, "0"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "foo.md"), `foo body ${index}`);
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 204, minScore: 0 });

    expect(results).toHaveLength(200);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(200);
    expect(results.some((entry) => entry.path === "memory/199/foo.md")).toBe(true);
  });

  it("uses body relevance within the same exact basename tier in FTS-only mode", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    const weakDir = path.join(fixture.paths.memory, "a");
    const strongDir = path.join(fixture.paths.memory, "z");
    await fs.mkdir(weakDir, { recursive: true });
    await fs.mkdir(strongDir, { recursive: true });
    await fs.writeFile(path.join(weakDir, "foo.md"), "Unrelated weak body.");
    await fs.writeFile(path.join(strongDir, "foo.md"), "foo md foo md foo md strong body");
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/z/foo.md");
    expect(results[0]?.score).toBe(1);
  });

  it("returns exact basename candidates with fixed FTS ranking", async () => {
    providerFixture.forceNoProvider = true;
    const staleDir = path.join(fixture.paths.root, "decay-a-stale");
    const freshDir = path.join(fixture.paths.root, "decay-z-fresh");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    const staleFooPath = path.join(staleDir, "foo.md");
    const freshFooPath = path.join(freshDir, "foo.md");
    const staleBarPath = path.join(staleDir, "bar.md");
    await fs.writeFile(staleFooPath, "Unrelated stale candidate.");
    await fs.writeFile(freshFooPath, "Unrelated fresh candidate.");
    await fs.writeFile(staleBarPath, "bar md bar md bar md strongest stale body");
    await fs.writeFile(path.join(freshDir, "bar.md"), "bar md fresh body");
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    await Promise.all([
      fs.utimes(staleFooPath, staleMtime, staleMtime),
      fs.utimes(staleBarPath, staleMtime, staleMtime),
    ]);
    const cfg = createCfg({
      provider: "none",
      extraPaths: [staleDir, freshDir],
      minScore: 0,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }
    await manager.sync({ reason: "test" });

    for (const basename of ["foo.md", "bar.md"]) {
      const results = await manager.search(basename, { maxResults: 1, minScore: 0 });
      expect(results).toHaveLength(1);
      expect(results[0]?.score).toBe(1);
    }
  });

  it("applies the fixed FTS candidate cap to exact paths", async () => {
    providerFixture.forceNoProvider = true;
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixture.paths.root, `decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "foo.md");
      await fs.mkdir(extraDir, { recursive: true });
      const body = index < 4 ? "foo md stale content candidate." : "Unrelated fresh candidate.";
      await fs.writeFile(filePath, body);
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      provider: "none",
      extraPaths,
      minScore: 0,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("applies the fixed hybrid candidate cap", async () => {
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixture.paths.root, `hybrid-decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "alpha.md");
      await fs.mkdir(extraDir, { recursive: true });
      const body = index === 4 ? "Alpha beta lower-similarity candidate." : "Alpha candidate.";
      await fs.writeFile(filePath, body);
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      extraPaths,
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("keeps fixed hybrid ranking when search degrades to keyword-only", async () => {
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixture.paths.root, `degraded-decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "beta.md");
      await fs.mkdir(extraDir, { recursive: true });
      await fs.writeFile(filePath, "Beta equal content candidate.");
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      extraPaths,
      fallback: "none",
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const degraded = manager as unknown as {
      provider: EmbeddingProvider | null;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
    };
    const provider = degraded.provider;
    if (!provider) {
      throw new Error("Expected a test embedding provider");
    }
    provider.embed = async () => {
      throw providerFixture.createLocalWorkerExitError();
    };
    degraded.markLocalEmbeddingProviderDegraded = () => {
      degraded.provider = null;
    };

    const results = await manager.search("beta.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("keeps body relevance for an exact basename beyond the exact candidate cap", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    const duplicatesDir = path.join(fixture.paths.memory, "readme-dupes");
    for (let index = 0; index < 205; index += 1) {
      const duplicateDir = path.join(duplicatesDir, `a-${index.toString().padStart(3, "0")}`);
      await fs.mkdir(duplicateDir, { recursive: true });
      await fs.writeFile(path.join(duplicateDir, "README.md"), "Unrelated weak body.");
    }
    const strongDir = path.join(duplicatesDir, "z-strong");
    await fs.mkdir(strongDir, { recursive: true });
    await fs.writeFile(
      path.join(strongDir, "README.md"),
      "README md README md README md strongest body match.",
    );
    await fs.writeFile(
      path.join(fixture.paths.memory, "readme-body-only.md"),
      "README md body-only candidate.",
    );
    await fs.writeFile(
      path.join(fixture.paths.memory, "README.md.notes"),
      "Unrelated partial path.",
    );
    await manager.sync({ reason: "test" });

    const results = await manager.search("README.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/readme-dupes/z-strong/README.md");
    expect(results[0]?.score).toBe(1);
  });

  it("keeps boosted score ordering for non-exact FTS-only body matches", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    trackManager(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(fixture.paths.memory, "project-memory-notes.md"),
      "Project memory notes covering workspace context and retrieval behavior.",
    );
    await fs.writeFile(path.join(fixture.paths.memory, "notes.md"), "Project memory context.");
    await manager.sync({ reason: "test" });

    const results = await manager.search("project memory context", {
      maxResults: 1,
      minScore: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/project-memory-notes.md");
    expect(results[0]?.score).toBeLessThanOrEqual(1);
  });

  it("prefers exact session transcript hits in FTS-only mode", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-ranking",
      });
      if (!manager) {
        return;
      }

      const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
      await fs.writeFile(memoryPath, "Project Nebula stale codename: ORBIT-9.\n", "utf8");
      const staleAt = new Date("2020-01-01T00:00:00.000Z");
      await fs.utimes(memoryPath, staleAt, staleAt);

      const now = Date.parse("2026-04-07T15:25:04.113Z");
      await seedMemoryIndexSessionTranscript({
        sessionId: "session-ranking",
        messages: [
          {
            role: "user",
            timestamp: new Date(now - 30_000).toISOString(),
            content: "What is the current Project Nebula codename?",
          },
          {
            role: "assistant",
            timestamp: new Date(now).toISOString(),
            content: "The current Project Nebula codename is ORBIT-10.",
          },
        ],
      });

      await manager.sync({ reason: "test", force: true });
      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
      expect(results[0]?.provenance).toMatchObject({
        originClass: "untrusted",
        sessionKind: "interactive",
      });
    } finally {
      fixture.restoreStateDir();
    }
  });

  it("ranks substring-only recall without reporting perfect confidence", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        ftsTokenizer: "trigram",
        minScore: 0,
        hybrid: { enabled: true },
      }),
    );
    if (!manager.status().fts?.available) {
      return;
    }
    await fs.writeFile(path.join(fixture.paths.memory, "a-weak.md"), "记忆 alpha beta gamma");
    await fs.writeFile(path.join(fixture.paths.memory, "z-strong.md"), "记忆");
    await manager.sync({ reason: "test" });

    const results = await manager.search("记忆", { maxResults: 2, minScore: 0 });

    expect(results.map((entry) => entry.path)).toEqual(["memory/z-strong.md", "memory/a-weak.md"]);
    expect(results.every((entry) => entry.score > 0 && entry.score < 1)).toBe(true);
    expect(results.every((entry) => !("hasBodyMatch" in entry))).toBe(true);
  });

  it("keeps substring-only body ranking within an exact hybrid tier", async () => {
    const manager = await getPersistentManager(
      createCfg({
        ftsTokenizer: "trigram",
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      }),
    );
    if (!manager.status().fts?.available) {
      return;
    }
    const weakDir = path.join(fixture.paths.memory, "a");
    const strongDir = path.join(fixture.paths.memory, "z");
    await fs.mkdir(weakDir, { recursive: true });
    await fs.mkdir(strongDir, { recursive: true });
    await fs.writeFile(path.join(weakDir, "记忆.md"), "记忆 alpha beta gamma");
    await fs.writeFile(path.join(strongDir, "记忆.md"), "记忆");
    await manager.sync({ reason: "test" });

    const results = await manager.search("记忆", { maxResults: 2, minScore: 0 });

    expect(results.map((entry) => entry.path)).toEqual(["memory/z/记忆.md", "memory/a/记忆.md"]);
  });
});
