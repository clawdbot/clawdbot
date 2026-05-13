import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  isShortTermMemoryPath,
  recordGroundedShortTermCandidates,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermPhaseSignalStorePath,
  resolveShortTermRecallStorePath,
  __testing,
} from "./short-term-promotion.js";

describe("short-term promotion", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  async function writeDailyMemoryNoteInSubdir(
    workspaceDir: string,
    subdir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const dir = path.join(workspaceDir, "memory", subdir);
    await fs.mkdir(dir, { recursive: true });
    const notePath = path.join(dir, `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  function requireCandidateKey(
    candidate: { key?: string } | null | undefined,
    label: string,
  ): string {
    if (!candidate?.key) {
      throw new Error(`expected ${label} candidate key`);
    }
    return candidate.key;
  }

  function requirePromotedAt(
    candidate: { promotedAt?: string } | null | undefined,
    label: string,
  ): string {
    if (typeof candidate?.promotedAt !== "string" || candidate.promotedAt.length === 0) {
      throw new Error(`expected ${label} promotedAt timestamp`);
    }
    return candidate.promotedAt;
  }

  async function expectEnoent(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toHaveProperty("code", "ENOENT");
  }

  it("detects short-term daily memory paths", () => {
    expect(isShortTermMemoryPath("memory/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/.dreams/session-corpus/2026-04-03.txt")).toBe(true);
    expect(isShortTermMemoryPath("notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("MEMORY.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/network.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/daily/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/daily notes/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/日记/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/notes/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/nested/deep/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/dreaming/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/dreaming/deep/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("../../vault/memory/dreaming/deep/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("notes/daily/2026-04-03.md")).toBe(false);
  });

  it("records short-term recall for notes stored in a memory/ subdirectory", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "daily", "2026-04-03", [
        "Subdirectory recall integration test note.",
      ]);
      const relativePath = path.relative(workspaceDir, notePath).replaceAll("\\", "/");
      await recordShortTermRecalls({
        workspaceDir,
        query: "test query",
        results: [
          {
            path: relativePath,
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Subdirectory recall integration test note.",
          },
        ],
      });
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(store).length).toBeGreaterThan(0);
    });
  });

  it("records short-term recall for notes stored in spaced and Unicode memory subdirectories", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const spacedPath = await writeDailyMemoryNoteInSubdir(
        workspaceDir,
        "daily notes",
        "2026-04-03",
        ["Spaced subdirectory recall integration test note."],
      );
      const unicodePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "日记", "2026-04-04", [
        "Unicode subdirectory recall integration test note.",
      ]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "nested subdir query",
        results: [
          {
            path: path.relative(workspaceDir, spacedPath).replaceAll("\\", "/"),
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Spaced subdirectory recall integration test note.",
          },
          {
            path: path.relative(workspaceDir, unicodePath).replaceAll("\\", "/"),
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.85,
            snippet: "Unicode subdirectory recall integration test note.",
          },
        ],
      });

      const raw = await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8");
      expect(raw).toContain("memory/daily notes/2026-04-03.md");
      expect(raw).toContain("memory/日记/2026-04-04.md");
    });
  });

  it("ignores dream report paths when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "dream recall",
        results: [
          {
            path: "memory/dreaming/deep/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Auto-generated dream report should not seed promotions.",
          },
        ],
      });

      await expectEnoent(fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"));
    });
  });

  it("ignores prefixed dream report paths when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "prefixed dream recall",
        results: [
          {
            path: "../../vault/memory/dreaming/deep/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "External dream report should not seed promotions.",
          },
        ],
      });

      await expectEnoent(fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"));
    });
  });

  it("ignores contaminated dreaming snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "action preference",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.92,
            snippet:
              "Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
          },
        ],
      });

      const store = JSON.parse(
        await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ) as { version?: number; entries?: unknown };
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("ignores bullet-prefixed dreaming snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "action preference",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 5,
            score: 0.92,
            snippet: [
              "- Candidate: Default to action.",
              "  - confidence: 0.76",
              "  - evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1",
              "  - recalls: 3",
              "  - status: staged",
            ].join("\n"),
          },
        ],
      });

      const store = JSON.parse(
        await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ) as { version?: number; entries?: unknown };
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("keeps ordinary snippets that only quote dreaming prompt markers", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "debug note",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet:
              "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
          },
        ],
      });

      const store = JSON.parse(
        await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ) as { entries: Record<string, { snippet: string }> };
      const entries = Object.values(store.entries);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.snippet).toBe(
        "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
      );
    });
  });

  it("records recalls and ranks candidates with weighted scores", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router",
        results: [
          {
            path: "memory/2026-04-02.md",
            startLine: 3,
            endLine: 5,
            score: 0.9,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
          },
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 1,
            score: 0.99,
            snippet: "Long-term note",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "iot vlan",
        results: [
          {
            path: "memory/2026-04-02.md",
            startLine: 3,
            endLine: 5,
            score: 0.8,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0]?.recallCount).toBe(2);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.score).toBeGreaterThan(0);
      expect(ranked[0]?.conceptTags).toContain("router");
      expect(ranked[0]?.components.conceptual).toBeGreaterThan(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf-8");
      expect(raw).toContain("memory/2026-04-02.md");
      expect(raw).not.toContain("Long-term note");
    });
  });

  it("serializes concurrent recall writes so counts are not lost", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          recordShortTermRecalls({
            workspaceDir,
            query: `backup-${index % 4}`,
            results: [
              {
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 2,
                score: 0.9,
                snippet: "Move backups to S3 Glacier.",
                source: "memory",
              },
            ],
          }),
        ),
      );

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallCount).toBe(8);
      expect(ranked[0]?.uniqueQueries).toBe(4);
    });
  });

  it("uses default thresholds for promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({ workspaceDir });
      expect(ranked).toHaveLength(0);
    });
  });

  it("lets repeated dreaming-only daily signals clear the default promotion gates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const queryDays = ["2026-04-01", "2026-04-02", "2026-04-03"];
      let candidateKey = "";

      for (const [index, day] of queryDays.entries()) {
        const nowMs = Date.parse(`${day}T10:00:00.000Z`);
        await recordShortTermRecalls({
          workspaceDir,
          query: `__dreaming_daily__:${day}`,
          signalType: "daily",
          dedupeByQueryPerDay: true,
          dayBucket: day,
          nowMs,
          results: [
            {
              path: "memory/2026-04-01.md",
              startLine: 1,
              endLine: 2,
              score: 0.62,
              snippet: "Move backups to S3 Glacier.",
              source: "memory",
            },
          ],
        });

        const ranked = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs,
        });
        candidateKey = requireCandidateKey(ranked[0], "ranked daily");

        await recordDreamingPhaseSignals({
          workspaceDir,
          phase: "light",
          keys: [candidateKey],
          nowMs,
        });
        await recordDreamingPhaseSignals({
          workspaceDir,
          phase: "rem",
          keys: [candidateKey],
          nowMs: nowMs + 60_000,
        });

        if (index < 2) {
          const beforeThreshold = await rankShortTermPromotionCandidates({
            workspaceDir,
            nowMs,
          });
          expect(beforeThreshold).toHaveLength(0);
        }
      }

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:01:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallCount).toBe(0);
      expect(ranked[0]?.dailyCount).toBe(3);
      expect(ranked[0]?.uniqueQueries).toBe(3);
      expect(ranked[0]?.recallDays).toEqual(queryDays);
      expect(ranked[0]?.score).toBeGreaterThanOrEqual(0.75);
    });
  });

  it("lets grounded durable evidence satisfy default deep thresholds", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        'Always use "Happy Together" calendar for flights and reservations.',
      ]);

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.82,
            query: "__dreaming_grounded_backfill__:candidate",
            signalCount: 1,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: true,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.groundedCount).toBe(3);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.avgScore).toBeGreaterThan(0.85);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memory).toContain('Always use "Happy Together" calendar');
    });
  });

  it("removes grounded-only staged entries without deleting mixed live entries", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Grounded only rule.",
        "Live recall-backed rule.",
      ]);

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: "Grounded only rule.",
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 2,
            endLine: 2,
            snippet: "Live recall-backed rule.",
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: true,
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "live recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 2,
            endLine: 2,
            score: 0.87,
            snippet: "Live recall-backed rule.",
            source: "memory",
          },
        ],
      });

      const result = await removeGroundedShortTermCandidates({ workspaceDir });
      expect(result.removed).toBe(1);

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.snippet).toContain("Live recall-backed rule");
      expect(ranked[0]?.groundedCount).toBe(2);
      expect(ranked[0]?.recallCount).toBe(1);
    });
  });

  it("rewards spaced recalls as consolidation instead of only raw count", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.9,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "iot segment",
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.88,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01", "2026-04-04"]);
      expect(ranked[0]?.components.consolidation).toBeGreaterThan(0.4);
    });
  });

  it("lets recency half-life tune the temporal score", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier retention",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const slowerDecay = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 14,
      });
      const fasterDecay = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 7,
      });

      expect(slowerDecay).toHaveLength(1);
      expect(fasterDecay).toHaveLength(1);
      expect(slowerDecay[0]?.components.recency).toBeCloseTo(0.5, 3);
      expect(fasterDecay[0]?.components.recency).toBeCloseTo(0.25, 3);
      expect(slowerDecay[0].score).toBeGreaterThan(fasterDecay[0].score);
    });
  });

  it("boosts deep ranking when light/rem phase signals reinforce a candidate", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "router setup",
        nowMs,
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
          },
          {
            path: "memory/2026-04-02.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "router backup",
        nowMs,
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
          },
          {
            path: "memory/2026-04-02.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
          },
        ],
      });

      const baseline = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      expect(baseline).toHaveLength(2);
      expect(baseline[0]?.path).toBe("memory/2026-04-01.md");

      const boostedKey = requireCandidateKey(
        baseline.find((entry) => entry.path === "memory/2026-04-02.md"),
        "boosted baseline",
      );
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: [boostedKey],
        nowMs,
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [boostedKey],
        nowMs,
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

      const phaseStorePath = resolveShortTermPhaseSignalStorePath(workspaceDir);
      const phaseStore = JSON.parse(await fs.readFile(phaseStorePath, "utf-8")) as {
        entries: Record<string, { lightHits: number; remHits: number }>;
      };
      expect(phaseStore.entries[boostedKey]?.lightHits).toBe(1);
      expect(phaseStore.entries[boostedKey]?.remHits).toBe(1);
    });
  });

  it("weights fresh phase signals more than stale ones", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier cadence",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "backup lifecycle",
        nowMs: Date.parse("2026-04-01T12:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const rankedBaseline = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      const key = requireCandidateKey(rankedBaseline[0], "ranked baseline");

      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [key],
        nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
      });
      const staleSignalRank = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [key],
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      const freshSignalRank = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });

      expect(staleSignalRank).toHaveLength(1);
      expect(freshSignalRank).toHaveLength(1);
      expect(freshSignalRank[0].score).toBeGreaterThan(staleSignalRank[0].score);
    });
  });

  it("reconciles existing promotion markers instead of appending duplicates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "line 1",
        "line 2",
        "The gateway should stay loopback-only on port 18789.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway loopback",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 3,
            endLine: 3,
            score: 0.95,
            snippet: "The gateway should stay loopback-only on port 18789.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const firstApply = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(firstApply.applied).toBe(1);
      expect(firstApply.appended).toBe(1);
      expect(firstApply.reconciledExisting).toBe(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { promotedAt?: string }>;
      };
      for (const entry of Object.values(rawStore.entries)) {
        delete entry.promotedAt;
      }
      await fs.writeFile(storePath, `${JSON.stringify(rawStore, null, 2)}\n`, "utf-8");

      const secondApply = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(secondApply.applied).toBe(1);
      expect(secondApply.appended).toBe(0);
      expect(secondApply.reconciledExisting).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
      expect(
        memoryText.match(/The gateway should stay loopback-only on port 18789\./g)?.length,
      ).toBe(1);
    });
  });

  it("filters out candidates older than maxAgeDays during ranking", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "old note",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        maxAgeDays: 7,
      });

      expect(ranked).toHaveLength(0);
    });
  });

  it("treats negative threshold overrides as invalid and keeps defaults", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: -1,
        minRecallCount: -1,
        minUniqueQueries: -1,
      });
      expect(ranked).toHaveLength(0);
    });
  });

  it("enforces default thresholds during apply even when candidates are passed directly", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: [
          {
            key: "memory:memory/2026-04-03.md:1:2",
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            avgScore: 0.95,
            maxScore: 0.95,
            uniqueQueries: 1,
            firstRecalledAt: new Date().toISOString(),
            lastRecalledAt: new Date().toISOString(),
            ageDays: 0,
            score: 0.95,
            recallDays: [new Date().toISOString().slice(0, 10)],
            conceptTags: ["glacier", "backups"],
            components: {
              frequency: 0.2,
              relevance: 0.95,
              diversity: 0.2,
              recency: 1,
              consolidation: 0.2,
              conceptual: 0.4,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
    });
  });

  it("does not rank contaminated dreaming snippets from an existing short-term store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              contaminated: {
                key: "contaminated",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet:
                  "Reflections: Theme: assistant. confidence: 1.00 evidence: memory/.dreams/session-corpus/2026-04-08.txt:2-2 recalls: 4 status: staged",
                recallCount: 4,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 3.6,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
                recallDays: ["2026-04-03", "2026-04-04"],
                conceptTags: ["assistant"],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(ranked).toStrictEqual([]);
    });
  });

  it("treats diff-prefixed dreaming snippets as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "@@ -1,1 - Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("treats bracket-prefixed dreaming snippets as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "([ Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("does not treat ordinary candidate notes with daily-memory evidence as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "Candidate: move backups weekly. confidence: 0.76 evidence: memory/2026-04-08.md:1-1",
      ),
    ).toBe(false);
  });

  it("treats transcript-style dreaming prompt echoes as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "[main/dreaming-narrative-light.jsonl#L1] User: Write a dream diary entry from these memory fragments:",
      ),
    ).toBe(true);
  });

  it("treats snippets with metadata prefix before the Candidate marker as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "- - status: staged - Candidate: User: [cron:26fb656d] run thing - confidence: 0.00 - evidence: memory/.dreams/session-corpus/2026-04-12.txt:25-25 - recalls: 0 - status: staged",
      ),
    ).toBe(true);
  });

  it("treats snippets with confidence prefix before the Candidate marker as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "confidence: 0.58 - Candidate: Assistant: Mason shipped the enforcement pass. - evidence: memory/.dreams/session-corpus/2026-04-11.txt:167-167 - recalls: 0 - status: staged",
      ),
    ).toBe(true);
  });

  it("does not treat prose that mentions the word Candidate as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "The Candidate profile for Josh Rhoden shows he runs SEU's network admin team; stack is Cisco plus Meraki.",
      ),
    ).toBe(false);
  });

  describe("lineRangeOverlapsDreamingFence", () => {
    it("returns true when the range falls inside a Light Sleep fence", () => {
      const lines = [
        "# Daily note",
        "## Notes",
        "Real durable content.",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: some staged dream content",
        "<!-- openclaw:dreaming:light:end -->",
        "## After",
        "More real content.",
      ];
      // Line 6 (1-indexed) sits between the fence markers.
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(true);
    });

    it("returns false when the range sits entirely outside any dreaming fence", () => {
      const lines = [
        "# Daily note",
        "Real durable content.",
        "<!-- openclaw:dreaming:rem:start -->",
        "staged dream content",
        "<!-- openclaw:dreaming:rem:end -->",
        "More real content.",
      ];
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 2, 2)).toBe(false);
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(false);
    });

    it("returns true when the range straddles a fence boundary", () => {
      const lines = [
        "real line 1",
        "<!-- openclaw:dreaming:diary:start -->",
        "dream line",
        "<!-- openclaw:dreaming:diary:end -->",
        "real line 5",
      ];
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 2, 4)).toBe(true);
    });

    it("recovers after a fence end so later real content is not flagged", () => {
      const lines = [
        "<!-- openclaw:dreaming:light:start -->",
        "dream",
        "<!-- openclaw:dreaming:light:end -->",
        "real line 4",
        "<!-- openclaw:dreaming:rem:start -->",
        "more dream",
        "<!-- openclaw:dreaming:rem:end -->",
        "real line 8",
      ];
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 4, 4)).toBe(false);
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 8, 8)).toBe(false);
      expect(__testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(true);
    });
  });

  it("refuses to promote rehydrated candidates that land inside a managed dreaming fence", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const dailyPath = await writeDailyMemoryNote(workspaceDir, "2026-04-18", [
        "# 2026-04-18",
        "",
        "## Notes",
        "Legitimate durable observation about backups.",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: staged dream scratchwork",
        "<!-- openclaw:dreaming:light:end -->",
      ]);
      expect(dailyPath).toBeTruthy();

      const applied = await applyShortTermPromotions({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        candidates: [
          {
            key: "memory:memory/2026-04-18.md:8:8",
            path: "memory/2026-04-18.md",
            startLine: 8,
            endLine: 8,
            source: "memory",
            snippet: "- Candidate: staged dream scratchwork",
            recallCount: 3,
            avgScore: 0.9,
            maxScore: 0.9,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-17T00:00:00.000Z",
            lastRecalledAt: "2026-04-18T00:00:00.000Z",
            ageDays: 1,
            score: 0.9,
            recallDays: ["2026-04-17", "2026-04-18"],
            conceptTags: ["dream"],
            components: {
              frequency: 1,
              relevance: 0,
              diversity: 1,
              recency: 1,
              consolidation: 0,
              conceptual: 0,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
      const memoryText = await fs
        .readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")
        .catch(() => "");
      expect(memoryText).not.toContain("Promoted From Short-Term Memory");
      expect(memoryText).not.toContain("staged dream scratchwork");
    });
  });

  it("skips direct candidates that exceed maxAgeDays during apply", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        maxAgeDays: 7,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        candidates: [
          {
            key: "memory:memory/2026-04-01.md:1:1",
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Expired short-term note.",
            recallCount: 3,
            avgScore: 0.95,
            maxScore: 0.95,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            ageDays: 10,
            score: 0.95,
            recallDays: ["2026-04-01", "2026-04-02"],
            conceptTags: ["expired"],
            components: {
              frequency: 1,
              relevance: 1,
              diversity: 1,
              recency: 1,
              consolidation: 1,
              conceptual: 1,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
      await expectEnoent(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"));
    });
  });

  it("does not append contaminated dreaming snippets during direct apply", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        candidates: [
          {
            key: "memory:memory/2026-04-03.md:1:1",
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet:
              "Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
            recallCount: 4,
            avgScore: 0.97,
            maxScore: 0.97,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-03T00:00:00.000Z",
            lastRecalledAt: "2026-04-04T00:00:00.000Z",
            ageDays: 0,
            score: 0.99,
            recallDays: ["2026-04-03", "2026-04-04"],
            conceptTags: ["assistant"],
            components: {
              frequency: 1,
              relevance: 1,
              diversity: 1,
              recency: 1,
              consolidation: 1,
              conceptual: 1,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
      await expectEnoent(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"));
    });
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway host",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 12,
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(applied.applied).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory");
      expect(memoryText).toContain("memory/2026-04-01.md:10-10");

      const rankedAfter = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(rankedAfter).toHaveLength(0);

      const rankedIncludingPromoted = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
      });
      expect(rankedIncludingPromoted).toHaveLength(1);
      expect(requirePromotedAt(rankedIncludingPromoted[0], "promoted candidate")).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    });
  });

  it("does not re-append candidates that were promoted in a prior run", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway host",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 12,
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const first = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(first.applied).toBe(1);

      const second = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(second.applied).toBe(0);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      const sectionCount = memoryText.match(/Promoted From Short-Term Memory/g)?.length ?? 0;
      expect(sectionCount).toBe(1);
    });
  });

  it("rehydrates moved snippets from the live daily note before promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "intro",
        "summary",
        "Moved backups to S3 Glacier.",
        "Keep cold storage retention at 365 days.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(3);
      expect(applied.appliedCandidates[0]?.endLine).toBe(3);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("memory/2026-04-01.md:3-3");
    });
  });

  it("prefers the nearest matching snippet when the same text appears multiple times", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "header",
        "Repeat backup note.",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "Repeat backup note.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "backup repeat",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 8,
            endLine: 9,
            score: 0.9,
            snippet: "Repeat backup note.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(9);
      expect(applied.appliedCandidates[0]?.endLine).toBe(10);
    });
  });

  it("rehydrates legacy basename-only short-term paths from the memory directory", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Legacy basename path note."]);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: [
          {
            key: "memory:2026-04-01.md:1:1",
            path: "2026-04-01.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Legacy basename path note.",
            recallCount: 2,
            avgScore: 0.9,
            maxScore: 0.95,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            ageDays: 0,
            score: 0.9,
            recallDays: ["2026-04-01", "2026-04-02"],
            conceptTags: ["legacy", "note"],
            components: {
              frequency: 0.3,
              relevance: 0.9,
              diversity: 0.4,
              recency: 1,
              consolidation: 0.5,
              conceptual: 0.3,
            },
          },
        ],
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("source=2026-04-01.md:1-1");
    });
  });

  it("skips promotion when the live daily note no longer contains the snippet", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Different note content now."]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(0);
      await expectEnoent(fs.access(path.join(workspaceDir, "MEMORY.md")));
    });
  });

  it("uses dreaming timezone for recall-day bucketing and promotion headers", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "Cross-midnight router maintenance window.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "router window",
        nowMs: Date.parse("2026-04-01T23:30:00.000Z"),
        timezone: "America/Los_Angeles",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Cross-midnight router maintenance window.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01"]);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-02T06:30:00.000Z"),
        timezone: "America/Los_Angeles",
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory (2026-04-01)");
    });
  });

  it("audits and repairs invalid store metadata plus stale locks", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              good: {
                key: "good",
                path: "memory/2026-04-01.md",
                startLine: 1,
                endLine: 2,
                source: "memory",
                snippet: "Gateway host uses qmd vector search for router notes.",
                recallCount: 2,
                totalScore: 1.8,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-01T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
              },
              bad: {
                path: "",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      await fs.writeFile(lockPath, "999999:0\n", "utf-8");
      const staleMtime = new Date(Date.now() - 120_000);
      await fs.utimes(lockPath, staleMtime, staleMtime);

      const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditBefore.invalidEntryCount).toBe(1);
      expect(auditBefore.issues.map((issue) => issue.code)).toStrictEqual([
        "recall-store-invalid",
        "recall-lock-stale",
      ]);

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedStaleLock).toBe(true);

      const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditAfter.invalidEntryCount).toBe(0);
      expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");

      const repairedRaw = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { conceptTags?: string[]; recallDays?: string[] }>;
      };
      expect(repairedRaw.entries.good?.conceptTags).toContain("router");
      expect(repairedRaw.entries.good?.recallDays).toEqual(["2026-04-04"]);
    });
  });

  it("repairs empty recall-store files without throwing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(storePath, "   \n", "utf-8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        version?: number;
        entries?: unknown;
      };
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("does not rewrite an already normalized healthy recall store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const snippet = "Gateway host uses qmd vector search for router notes.";
      const raw = `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          entries: {
            good: {
              key: "good",
              path: "memory/2026-04-01.md",
              startLine: 1,
              endLine: 2,
              source: "memory",
              snippet,
              recallCount: 2,
              dailyCount: 0,
              groundedCount: 0,
              totalScore: 1.8,
              maxScore: 0.95,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: "2026-04-04T00:00:00.000Z",
              queryHashes: ["a", "b"],
              recallDays: ["2026-04-04"],
              conceptTags: __testing.deriveConceptTags({
                path: "memory/2026-04-01.md",
                snippet,
              }),
            },
          },
        },
        null,
        2,
      )}\n`;
      await fs.writeFile(storePath, raw, "utf-8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(false);
      expect(repair.rewroteStore).toBe(false);
      const nextRaw = await fs.readFile(storePath, "utf-8");
      expect(nextRaw).toBe(raw);
    });
  });

  it("waits for an active short-term lock before repairing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bad: {
                path: "",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf-8");

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let settled = false;
        const repairPromise = repairShortTermPromotionArtifacts({ workspaceDir }).then((result) => {
          settled = true;
          return result;
        });

        await vi.advanceTimersByTimeAsync(41);
        expect(settled).toBe(false);

        await fs.unlink(lockPath);
        await vi.advanceTimersByTimeAsync(40);
        const repair = await repairPromise;

        expect(repair.changed).toBe(true);
        expect(repair.rewroteStore).toBe(true);
        expect(repair.removedInvalidEntries).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("downgrades lock inspection failures into audit issues", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      const stat = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        if (String(target) === lockPath) {
          const error = Object.assign(new Error("no access"), { code: "EACCES" });
          throw error;
        }
        return await vi
          .importActual<typeof import("node:fs/promises")>("node:fs/promises")
          .then((actual) => actual.stat(target));
      });
      try {
        const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
        const lockIssue = audit.issues.find((issue) => issue.code === "recall-lock-unreadable");
        expect(lockIssue).toStrictEqual({
          severity: "warn",
          code: "recall-lock-unreadable",
          message: "Short-term promotion lock could not be inspected: EACCES.",
          fixable: false,
        });
      } finally {
        stat.mockRestore();
      }
    });
  });

  it("reports concept tag script coverage for multilingual recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "routeur glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.93,
            snippet: "Configuration du routeur et sauvegarde Glacier.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "router cjk",
        results: [
          {
            path: "memory/2026-04-04.md",
            startLine: 1,
            endLine: 2,
            score: 0.95,
            snippet: "障害対応ルーター設定とバックアップ確認。",
            source: "memory",
          },
        ],
      });

      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.conceptTaggedEntryCount).toBe(2);
      expect(audit.conceptTagScripts).toEqual({
        latinEntryCount: 1,
        cjkEntryCount: 1,
        mixedEntryCount: 0,
        otherEntryCount: 0,
      });
    });
  });

  it("extracts stable concept tags from snippets and paths", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Move backups to S3 Glacier and sync QMD router notes.",
      }),
    ).toStrictEqual(["backup", "backups", "glacier", "qmd", "router", "sync"]);
  });

  it("extracts multilingual concept tags across latin and cjk snippets", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Configuración du routeur et sauvegarde Glacier.",
      }),
    ).toStrictEqual(["glacier", "sauvegarde", "routeur", "configuración"]);
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。",
      }),
    ).toStrictEqual([
      "バックアップ",
      "ルーター",
      "障害対応",
      "路由器",
      "备份",
      "网关",
      "障害",
      "対応",
    ]);
  });

  describe("MEMORY.md budget compaction (#73691)", () => {
    it("drops the oldest promoted section before write when memoryFileMaxChars would be exceeded", async () => {
      await withTempWorkspace(async (workspaceDir) => {
        // Source daily note that the candidate references (rehydrate reads it).
        await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
          "Notes",
          "",
          "Rotate the staging Postgres credentials before next deploy.",
        ]);

        // Seed an oversized MEMORY.md with two pre-existing promotion sections.
        const memoryPath = path.join(workspaceDir, "MEMORY.md");
        const filler = "x".repeat(600);
        const seeded = [
          "# Long-Term Memory",
          "",
          "## Promoted From Short-Term Memory (2026-04-10)",
          "<!-- openclaw-memory-promotion:legacy-old -->",
          `- ${filler}`,
          "",
          "## Promoted From Short-Term Memory (2026-04-20)",
          "<!-- openclaw-memory-promotion:legacy-newer -->",
          `- ${filler}`,
          "",
        ].join("\n");
        await fs.writeFile(memoryPath, seeded, "utf-8");

        await recordShortTermRecalls({
          workspaceDir,
          query: "rotate creds",
          nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
          results: [
            {
              path: "memory/2026-04-29.md",
              startLine: 3,
              endLine: 3,
              score: 0.96,
              snippet: "Rotate the staging Postgres credentials before next deploy.",
              source: "memory",
            },
          ],
        });

        const ranked = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
        });

        const applied = await applyShortTermPromotions({
          workspaceDir,
          candidates: ranked,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
          memoryFileMaxChars: 1_400,
        });

        expect(applied.applied).toBe(1);
        expect(applied.compactedSections).toBeGreaterThan(0);
        expect(applied.compactedDates).toContain("2026-04-10");

        const memoryText = await fs.readFile(memoryPath, "utf-8");
        expect(memoryText).not.toContain("(2026-04-10)");
        expect(memoryText).not.toContain("legacy-old");
        // Newer pre-existing section + the freshly-written one survive.
        expect(memoryText).toContain("Rotate the staging Postgres credentials");
      });
    });

    it("leaves MEMORY.md untouched when total stays within memoryFileMaxChars", async () => {
      await withTempWorkspace(async (workspaceDir) => {
        await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
          "Notes",
          "",
          "A short snippet that fits comfortably.",
        ]);

        const memoryPath = path.join(workspaceDir, "MEMORY.md");
        const seeded = "# Long-Term Memory\n\nSome small existing content.\n";
        await fs.writeFile(memoryPath, seeded, "utf-8");

        await recordShortTermRecalls({
          workspaceDir,
          query: "tiny note",
          nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
          results: [
            {
              path: "memory/2026-04-29.md",
              startLine: 3,
              endLine: 3,
              score: 0.92,
              snippet: "A short snippet that fits comfortably.",
              source: "memory",
            },
          ],
        });

        const ranked = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
        });

        const applied = await applyShortTermPromotions({
          workspaceDir,
          candidates: ranked,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          memoryFileMaxChars: 10_000,
        });

        expect(applied.compactedSections).toBe(0);
        expect(applied.compactedDates).toEqual([]);
        const memoryText = await fs.readFile(memoryPath, "utf-8");
        expect(memoryText).toContain("Some small existing content.");
      });
    });
  });
});
