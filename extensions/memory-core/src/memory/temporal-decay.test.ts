// Memory Core tests cover temporal decay plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { mergeHybridResults } from "./hybrid.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 1, 10, 0, 0, 0);
const { createTempWorkspace } = createMemoryCoreTestHarness();

function createVectorMemoryEntry(params: {
  id: string;
  path: string;
  snippet: string;
  vectorScore: number;
}) {
  return {
    id: params.id,
    path: params.path,
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: params.snippet,
    vectorScore: params.vectorScore,
  };
}

async function mergeVectorResultsWithTemporalDecay(
  vector: Parameters<typeof mergeHybridResults>[0]["vector"],
) {
  return mergeHybridResults({
    vectorWeight: 1,
    textWeight: 0,
    temporalDecay: { enabled: true, halfLifeDays: 30 },
    mmr: { enabled: false },
    nowMs: NOW_MS,
    vector,
    keyword: [],
  });
}

describe("temporal decay", () => {
  it("does not decay evergreen memory files", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");

    const rootMemoryPath = path.join(dir, "MEMORY.md");
    const userMemoryPath = path.join(dir, "USER.md");
    const topicPath = path.join(dir, "memory", "projects.md");
    await fs.mkdir(path.dirname(topicPath), { recursive: true });
    await fs.writeFile(rootMemoryPath, "evergreen");
    await fs.writeFile(userMemoryPath, "user evergreen");
    await fs.writeFile(topicPath, "topic evergreen");

    const veryOld = new Date(Date.UTC(2010, 0, 1));
    await fs.utimes(rootMemoryPath, veryOld, veryOld);
    await fs.utimes(userMemoryPath, veryOld, veryOld);
    await fs.utimes(topicPath, veryOld, veryOld);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [
        { path: "MEMORY.md", score: 1, source: "memory" },
        { path: "USER.md", score: 0.9, source: "memory" },
        { path: "memory/projects.md", score: 0.75, source: "memory" },
      ],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(1);
    expect(decayed[1]?.score).toBeCloseTo(0.9);
    expect(decayed[2]?.score).toBeCloseTo(0.75);
  });

  it("applies decay in hybrid merging before ranking", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry({
        id: "old",
        path: "memory/2025-01-01.md",
        snippet: "old but high",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "new",
        path: "memory/2026-02-10.md",
        snippet: "new and relevant",
        vectorScore: 0.8,
      }),
    ]);

    expect(merged[0]?.path).toBe("memory/2026-02-10.md");
    expect(merged[0]?.score ?? 0).toBeGreaterThan(merged[1]?.score ?? 0);
  });

  it("decays dated and slugged memory files at any depth by their embedded date", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry({
        id: "nested-old",
        path: "memory/dreaming/light/2025-01-01.md",
        snippet: "stale dreaming report",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "root-old",
        path: "memory/2025-01-01.md",
        snippet: "stale daily note",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "root-timestamp",
        path: "memory/2025-01-01-1430.md",
        snippet: "stale session memory",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "root-collision",
        path: "memory/2025-01-01-1430-2.md",
        snippet: "stale colliding session memory",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "nested-slug",
        path: "memory/dreaming/light/2025-01-01-vendor-pitch.md",
        snippet: "stale named dreaming report",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "nested-undated",
        path: "memory/dreaming/light/report.md",
        snippet: "undated evergreen",
        vectorScore: 0.7,
      }),
    ]);

    const byPath = new Map(merged.map((entry) => [entry.path, entry]));
    const nestedOld = byPath.get("memory/dreaming/light/2025-01-01.md");
    const rootOld = byPath.get("memory/2025-01-01.md");
    expect(nestedOld?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(nestedOld?.score ?? 1).toBeLessThan(0.5);
    expect(byPath.get("memory/2025-01-01-1430.md")?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(byPath.get("memory/2025-01-01-1430-2.md")?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(byPath.get("memory/dreaming/light/2025-01-01-vendor-pitch.md")?.score).toBeCloseTo(
      rootOld?.score ?? 0,
    );
    expect(byPath.get("memory/dreaming/light/report.md")?.score).toBeCloseTo(0.7);
  });

  it("decays nested dated and slugged memory files with Windows-style separators", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry({
        id: "win-nested-old",
        path: "memory\\dreaming\\light\\2025-01-01.md",
        snippet: "stale dreaming report",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "win-nested-slug",
        path: "memory\\dreaming\\light\\2025-01-01-1430.md",
        snippet: "stale session memory",
        vectorScore: 0.95,
      }),
      createVectorMemoryEntry({
        id: "win-nested-undated",
        path: "memory\\dreaming\\light\\report.md",
        snippet: "undated evergreen",
        vectorScore: 0.7,
      }),
    ]);

    const byPath = new Map(merged.map((entry) => [entry.path, entry]));
    expect(byPath.get("memory\\dreaming\\light\\2025-01-01.md")?.score ?? 1).toBeLessThan(0.5);
    expect(byPath.get("memory\\dreaming\\light\\2025-01-01-1430.md")?.score ?? 1).toBeLessThan(0.5);
    expect(byPath.get("memory\\dreaming\\light\\report.md")?.score).toBeCloseTo(0.7);
  });

  it("handles future dates, zero age, and very old memories", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry({
        id: "future",
        path: "memory/2099-01-01.md",
        snippet: "future",
        vectorScore: 0.9,
      }),
      createVectorMemoryEntry({
        id: "today",
        path: "memory/2026-02-10.md",
        snippet: "today",
        vectorScore: 0.8,
      }),
      createVectorMemoryEntry({
        id: "very-old",
        path: "memory/2000-01-01.md",
        snippet: "ancient",
        vectorScore: 1,
      }),
    ]);

    const byPath = new Map(merged.map((entry) => [entry.path, entry]));
    expect(byPath.get("memory/2099-01-01.md")?.score).toBeCloseTo(0.9);
    expect(byPath.get("memory/2026-02-10.md")?.score).toBeCloseTo(0.8);
    expect(byPath.get("memory/2000-01-01.md")?.score ?? 1).toBeLessThan(0.001);
  });

  it("uses file mtime for additional memory files", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");
    const filePath = path.join(dir, "notes", "topic.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "notes\n");
    const oldMtime = new Date(NOW_MS - 30 * DAY_MS);
    await fs.utimes(filePath, oldMtime, oldMtime);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [{ path: "notes/topic.md", score: 1, source: "memory" }],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });

  it("leaves session timestamps unknown when their indexed source is missing", async () => {
    const entry = { path: "sessions/main/missing.jsonl", score: 1, source: "sessions" };
    expect(
      await applyTemporalDecayToHybridResults({
        results: [entry],
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        sessionSourceMtimes: new Map(),
        nowMs: NOW_MS,
      }),
    ).toEqual([entry]);
  });
});
