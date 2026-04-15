import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { mergeHybridResults } from "./hybrid.js";
import {
  applyTemporalDecayToHybridResults,
  applyTemporalDecayToScore,
  calculateTemporalDecayMultiplier,
} from "./temporal-decay.js";

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
  it("matches exponential decay formula", () => {
    const halfLifeDays = 30;
    const ageInDays = 10;
    const lambda = Math.LN2 / halfLifeDays;
    const expectedMultiplier = Math.exp(-lambda * ageInDays);

    expect(calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays })).toBeCloseTo(
      expectedMultiplier,
    );
    expect(applyTemporalDecayToScore({ score: 0.8, ageInDays, halfLifeDays })).toBeCloseTo(
      0.8 * expectedMultiplier,
    );
  });

  it("is 0.5 exactly at half-life", () => {
    expect(calculateTemporalDecayMultiplier({ ageInDays: 30, halfLifeDays: 30 })).toBeCloseTo(0.5);
  });

  it("does not decay evergreen memory files", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");

    const rootMemoryPath = path.join(dir, "MEMORY.md");
    const topicPath = path.join(dir, "memory", "projects.md");
    await fs.mkdir(path.dirname(topicPath), { recursive: true });
    await fs.writeFile(rootMemoryPath, "evergreen");
    await fs.writeFile(topicPath, "topic evergreen");

    const veryOld = new Date(Date.UTC(2010, 0, 1));
    await fs.utimes(rootMemoryPath, veryOld, veryOld);
    await fs.utimes(topicPath, veryOld, veryOld);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [
        { path: "MEMORY.md", score: 1, source: "memory" },
        { path: "memory/projects.md", score: 0.75, source: "memory" },
      ],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(1);
    expect(decayed[1]?.score).toBeCloseTo(0.75);
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

  it("uses file mtime fallback for non-memory sources", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");
    const sessionPath = path.join(dir, "sessions", "thread.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, "{}\n");
    const oldMtime = new Date(NOW_MS - 30 * DAY_MS);
    await fs.utimes(sessionPath, oldMtime, oldMtime);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [{ path: "sessions/thread.jsonl", score: 1, source: "sessions" }],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });
});
