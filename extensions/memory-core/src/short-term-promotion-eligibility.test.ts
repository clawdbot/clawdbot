import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePromotionStaticRejection } from "./dreaming-consolidation-candidates.js";
import {
  DREAMING_DAILY_PROVENANCE_NAMESPACE,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { buildPromotionRecallAnnotations } from "./short-term-promotion-metadata.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  type PromotionCandidate,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function candidate(
  originClass: "agent" | "untrusted" | undefined,
  sessionKind: "interactive" | "cron" = "interactive",
): PromotionCandidate {
  return {
    key: `memory:session:${originClass}:${sessionKind}`,
    path: "memory/.dreams/session-corpus/2026-08-09.txt",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: "User: Keep encrypted backups in S3 Glacier.",
    recallCount: 3,
    signalCount: 3,
    avgScore: 0.9,
    maxScore: 0.9,
    uniqueQueries: 2,
    firstRecalledAt: "2026-08-09T10:00:00.000Z",
    lastRecalledAt: "2026-08-09T10:00:00.000Z",
    ageDays: 0,
    score: 0.9,
    recallDays: ["2026-08-08", "2026-08-09"],
    conceptTags: ["backup"],
    components: {
      frequency: 1,
      relevance: 0.9,
      diversity: 0.5,
      recency: 1,
      consolidation: 0.5,
      conceptual: 0.2,
    },
    ...(originClass
      ? {
          provenance: {
            originClass,
            sessionKind,
            observedAt: Date.parse("2026-08-09T10:00:00.000Z"),
          },
        }
      : {}),
  };
}

function createSubagent(output: string, onWait: () => Promise<void>) {
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => {
      await onWait();
      return { status: "ok" };
    }),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: output }],
    })),
    deleteSession: vi.fn(async () => undefined),
  };
}

describe("short-term promotion eligibility", () => {
  it("uses one static policy for trusted and blocked session candidates", () => {
    expect(resolvePromotionStaticRejection(candidate("agent"))).toBeNull();
    expect(resolvePromotionStaticRejection(candidate("agent", "cron"))).toBe(
      "non_interactive_session",
    );
    expect(resolvePromotionStaticRejection(candidate("untrusted"))).toBe("origin_blocked");
    expect(resolvePromotionStaticRejection(candidate(undefined), { requireProvenance: true })).toBe(
      "missing_provenance",
    );
  });

  it("reports a typed reason when the apply boundary rejects a ranked candidate", async () => {
    const result = await applyShortTermPromotions({
      workspaceDir: await createTempWorkspace("memory-promotion-eligibility-"),
      candidates: [candidate("untrusted")],
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      applied: 0,
      rejectedCandidates: [{ reason: "origin filter (untrusted)" }],
    });
  });

  it("excludes legacy missing-provenance entries from consolidation ranking", async () => {
    const workspaceDir = await createTempWorkspace("memory-promotion-legacy-provenance-");
    const legacy = {
      ...candidate(undefined),
      key: "memory:legacy:no-provenance",
      path: "memory/2026-08-09.md",
      dailyCount: 0,
      groundedCount: 0,
      totalScore: 2.7,
      queryHashes: ["query-1", "query-2"],
    };
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-08-09T10:00:00.000Z",
      entries: { [legacy.key]: legacy },
    });

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      requireProvenance: true,
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });

    expect(ranked).toHaveLength(0);
  });

  it("keeps trusted interactive session candidates eligible at the apply boundary", async () => {
    const workspaceDir = await createTempWorkspace("memory-promotion-interactive-");
    const trusted = candidate("agent");
    const sourcePath = path.join(workspaceDir, trusted.path);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, `${trusted.snippet}\n`, "utf8");

    const result = await applyShortTermPromotions({
      workspaceDir,
      candidates: [trusted],
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });

    expect(result).toMatchObject({ applied: 1, rejectedCandidates: [] });
  });

  it("rechecks daily-file quarantine after consolidation", async () => {
    const workspaceDir = await createTempWorkspace("memory-promotion-quarantine-race-");
    const relativePath = "memory/2026-08-09.md";
    const sourcePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "User prefers encrypted backups.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");
    await recordShortTermRecalls({
      workspaceDir,
      query: "backup preference",
      results: [
        {
          path: relativePath,
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "User prefers encrypted backups.",
          source: "memory",
          provenance: candidate("agent").provenance,
        },
      ],
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });
    const [ranked] = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });
    if (!ranked) {
      throw new Error("expected ranked candidate");
    }
    const resultEntry = `- ${ranked.snippet} Source: ${ranked.path}#L1-L1 ${buildPromotionRecallAnnotations(ranked)}`;
    const subagent = createSubagent(
      JSON.stringify({
        memory: `# Memory\n\n${resultEntry}\n`,
        operations: [{ candidateKey: ranked.key, action: "added", resultEntry, priorEntries: [] }],
      }),
      async () => {
        await writeMemoryCoreWorkspaceEntry({
          namespace: DREAMING_DAILY_PROVENANCE_NAMESPACE,
          workspaceDir,
          key: relativePath,
          value: { fileHash: "unchanged", originClass: "untrusted", observedAt: Date.now() },
        });
      },
    );

    const result = await applyShortTermPromotions({
      workspaceDir,
      candidates: [ranked],
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      consolidation: { subagent, logger: { info: vi.fn(), warn: vi.fn() } },
      nowMs: Date.parse("2026-08-09T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      applied: 0,
      rejectedCandidates: [{ reason: "static eligibility changed (origin_blocked)" }],
    });
  });
});
