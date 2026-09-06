// Memory Core tests cover search result monotonicity across requested counts.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import * as knnSubprocess from "./manager-search-knn-subprocess.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search result monotonicity", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig: createCfg, getFreshManager } = fixture;

  const hybridConfig = () =>
    createCfg({
      vectorEnabled: true,
      minScore: 0,
    });

  async function seedGradedCorpus(files: number): Promise<void> {
    // Descending "alpha" density spreads vector scores across more chunks than a
    // narrow window can hold, and the strongest sort last by path, so a window tied
    // to the requested count retrieves a different candidate set for a top-1 request.
    for (let index = 0; index < files; index += 1) {
      await fs.writeFile(
        path.join(fixture.paths.memory, `pool-note-${`${index}`.padStart(3, "0")}.md`),
        `# Pool note ${index}\n${"alpha ".repeat(files - index)}shared filler body.`,
      );
    }
  }

  it.each([
    // Corpus size must exceed the pre-fix retrieval window for the path under test:
    // an ordinary top-1 fetched maxResults*4, while a project-aware top-1 expanded to
    // 4 first, so it only shows the defect once candidates outnumber 4*4.
    { name: "an ordinary search", activeProjectKeys: undefined, files: 12 },
    { name: "a project-aware search", activeProjectKeys: ["pool-project"], files: 40 },
  ])(
    "keeps the top hit stable when $name requests fewer results than the default",
    async ({ activeProjectKeys, files }) => {
      await seedGradedCorpus(files);
      const manager = await getFreshManager(hybridConfig());
      try {
        await manager.sync({ reason: "test" });
        const wide = await manager.search("alpha", {
          maxResults: 6,
          minScore: 0,
          activeProjectKeys,
        });
        const single = await manager.search("alpha", {
          maxResults: 1,
          minScore: 0,
          activeProjectKeys,
        });
        expect(wide[0]).toBeDefined();
        expect(single).toHaveLength(1);
        // Narrowing the window may only drop trailing rows, never promote a weaker
        // hit, so top-1 must stay the first row of the wider request.
        expect(single[0]?.path).toBe(wide[0]?.path);
        expect(single[0]?.score).toBeCloseTo(wide[0]?.score ?? 0, 10);
      } finally {
        await manager.close?.();
      }
    },
  );

  it.each([
    { name: "an ordinary search", activeProjectKeys: undefined },
    { name: "a project-aware search", activeProjectKeys: ["pool-project"] },
  ])(
    "retrieves one candidate width across requested counts for $name",
    async ({ activeProjectKeys }) => {
      await seedGradedCorpus(12);
      const manager = await getFreshManager(hybridConfig());
      try {
        await manager.sync({ reason: "test" });
        const knnLimits: number[] = [];
        const runKnn = knnSubprocess.runVectorKnnInSubprocess;
        vi.spyOn(knnSubprocess, "runVectorKnnInSubprocess").mockImplementation(async (params) => {
          knnLimits.push(params.request.limit);
          return await runKnn(params);
        });
        for (const maxResults of [1, 2, 6]) {
          await manager.search("alpha", { maxResults, minScore: 0, activeProjectKeys });
        }
        // Retrieval width must not vary with the requested count, otherwise fusion ranks
        // a different candidate set per call. Project expansion scales the one floored
        // window, so its width stays constant too.
        expect(new Set(knnLimits).size).toBe(1);
      } finally {
        vi.restoreAllMocks();
        await manager.close?.();
      }
    },
  );

  it.each([
    { name: "an ordinary search", activeProjectKeys: undefined, files: 40 },
    { name: "a project-aware search", activeProjectKeys: ["pool-project"], files: 80 },
  ])(
    "keeps the top hit stable when $name requests more results than the default",
    async ({ activeProjectKeys, files }) => {
      // The contract is prefix-monotonic across every count, not only below the
      // configured default: growing the request may append rows, never reorder them.
      await seedGradedCorpus(files);
      const manager = await getFreshManager(hybridConfig());
      try {
        await manager.sync({ reason: "test" });
        const wide = await manager.search("alpha", {
          maxResults: 20,
          minScore: 0,
          activeProjectKeys,
        });
        const narrow = await manager.search("alpha", {
          maxResults: 6,
          minScore: 0,
          activeProjectKeys,
        });
        expect(wide[0]).toBeDefined();
        expect(narrow[0]).toBeDefined();
        expect(narrow[0]?.path).toBe(wide[0]?.path);
        expect(narrow[0]?.score).toBeCloseTo(wide[0]?.score ?? 0, 10);
      } finally {
        await manager.close?.();
      }
    },
  );

  it("retrieves one candidate width above the configured default", async () => {
    await seedGradedCorpus(40);
    const manager = await getFreshManager(hybridConfig());
    try {
      await manager.sync({ reason: "test" });
      const knnLimits: number[] = [];
      const runKnn = knnSubprocess.runVectorKnnInSubprocess;
      vi.spyOn(knnSubprocess, "runVectorKnnInSubprocess").mockImplementation(async (params) => {
        knnLimits.push(params.request.limit);
        return await runKnn(params);
      });
      for (const maxResults of [6, 10, 20]) {
        await manager.search("alpha", { maxResults, minScore: 0 });
      }
      expect(new Set(knnLimits).size).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await manager.close?.();
    }
  });

  it("returns more than the candidate universe when the caller asks for more", async () => {
    // The fixed universe must behave as a retrieval floor. If it also caps selection,
    // a request above it silently loses qualifying hits that retrieval already held.
    await seedGradedCorpus(260);
    const manager = await getFreshManager(hybridConfig());
    try {
      await manager.sync({ reason: "test" });
      const wide = await manager.search("alpha", { maxResults: 250, minScore: 0 });
      expect(wide.length).toBeGreaterThan(200);

      // Widening past the universe must still not disturb the leader.
      const single = await manager.search("alpha", { maxResults: 1, minScore: 0 });
      expect(single[0]?.path).toBe(wide[0]?.path);
    } finally {
      await manager.close?.();
    }
  });

  it("keeps project-aware MMR bounded when the caller asks for more than the universe", async () => {
    await seedGradedCorpus(260);
    const manager = await getFreshManager(hybridConfig());
    try {
      await manager.sync({ reason: "test" });
      const results = await manager.search("alpha", {
        maxResults: 250,
        minScore: 0,
        activeProjectKeys: ["pool-project"],
      });
      expect(results).toHaveLength(200);
    } finally {
      await manager.close?.();
    }
  });
});
