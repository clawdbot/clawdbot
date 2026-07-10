// Memory Core tests cover short term promotion plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import {
  configureMemoryCoreDreamingState,
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
} from "./dreaming-state.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  filterLiveShortTermRecallEntries,
  isShortTermMemoryPath,
  loadShortTermPromotionDreamingStats,
  recordGroundedShortTermCandidates,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
  recordShortTermRecalls,
  readLightStagedKeys,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  testing,
} from "./short-term-promotion.js";

describe("short-term promotion", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  async function readRecallStoreEntries(workspaceDir: string): Promise<
    Record<
      string,
      {
        claimHash?: unknown;
        firstRecalledAt?: unknown;
        lastRecalledAt?: unknown;
        dailyCount?: unknown;
        recallCount?: unknown;
        snippet?: unknown;
        totalScore?: unknown;
      }
    >
  > {
    return await testing
      .readRecallStore(workspaceDir, new Date().toISOString())
      .then((store) => store.entries);
  }

  function readEntrySnippet(entry: { snippet?: unknown }): string {
    return typeof entry.snippet === "string" ? entry.snippet : "";
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
      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(Object.keys(store.entries).length).toBeGreaterThan(0);
    });
  });

  it("deduplicates source-file checks within a recall batch", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Deduplicated source check note.",
      ]);
      const relativePath = path.relative(workspaceDir, notePath).replaceAll("\\", "/");
      const entry = {
        key: "duplicate-source",
        path: relativePath,
        startLine: 1,
        endLine: 1,
        source: "memory" as const,
        snippet: "Deduplicated source check note.",
        recallCount: 1,
        dailyCount: 1,
        groundedCount: 0,
        totalScore: 0.9,
        maxScore: 0.9,
        firstRecalledAt: "2026-04-03T00:00:00.000Z",
        lastRecalledAt: "2026-04-03T00:00:00.000Z",
        queryHashes: ["query"],
        recallDays: ["2026-04-03"],
        conceptTags: [],
      };
      const statSpy = vi.spyOn(fs, "stat");

      const live = await filterLiveShortTermRecallEntries({
        workspaceDir,
        entries: [entry, { ...entry, key: "duplicate-source-2" }],
      });

      expect(live).toHaveLength(2);
      expect(statSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back when the injected recall timestamp is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNote(workspaceDir, "2026-05-30", [
        "Bounded recall timestamp note.",
      ]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "bounded recall",
        nowMs: 8_640_000_000_000_001,
        results: [
          {
            path: path.relative(workspaceDir, notePath).replaceAll("\\", "/"),
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Bounded recall timestamp note.",
          },
        ],
      });

      const [entry] = Object.values(await readRecallStoreEntries(workspaceDir));
      expect(entry?.firstRecalledAt).toBe("2026-05-30T12:00:00.000Z");
      expect(entry?.lastRecalledAt).toBe("2026-05-30T12:00:00.000Z");
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

      const raw = JSON.stringify(
        await testing.readRecallStore(workspaceDir, new Date().toISOString()),
      );
      expect(raw).toContain("memory/daily notes/2026-04-03.md");
      expect(raw).toContain("memory/日记/2026-04-04.md");
    });
  });

  it("caps short-term recall store entries and snippets during normal recording", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
      const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
      await recordShortTermRecalls({
        workspaceDir,
        query: "bounded recall",
        results: Array.from({ length: maxEntries + 5 }, (_, index) => ({
          path: "memory/2026-04-03.md",
          source: "memory" as const,
          startLine: index + 1,
          endLine: index + 1,
          score: 0.1 + index / (maxEntries + 5),
          snippet: `Recall entry ${index} ${"x".repeat(maxSnippetChars + 100)}`,
        })),
      });

      const entries = Object.values(await readRecallStoreEntries(workspaceDir));
      expect(entries).toHaveLength(maxEntries);
      expect(entries.every((entry) => readEntrySnippet(entry).length <= maxSnippetChars)).toBe(
        true,
      );
      expect(entries.some((entry) => readEntrySnippet(entry).startsWith("Recall entry 0 "))).toBe(
        false,
      );
      expect(
        entries.some((entry) =>
          readEntrySnippet(entry).startsWith(`Recall entry ${maxEntries + 4} `),
        ),
      ).toBe(true);
    });
  });

  it("keeps long-snippet claim identity stable while storing capped snippets", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
      const longSnippet = `Stable claim identity ${"x".repeat(maxSnippetChars + 100)}`;
      const claimHash = testing.buildClaimHash(longSnippet);

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: longSnippet,
            score: 0.9,
            query: "__dreaming_grounded_backfill__:candidate",
            signalCount: 1,
            dayBucket: "2026-04-03",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      await recordShortTermRecalls({
        workspaceDir,
        query: "stable claim",
        nowMs: Date.parse("2026-04-03T11:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet: longSnippet,
          },
        ],
      });

      const entries = Object.entries(await readRecallStoreEntries(workspaceDir));
      expect(entries).toHaveLength(1);
      const [key, entry] = entries[0];
      expect(key.endsWith(`:${claimHash}`)).toBe(true);
      expect(entry.claimHash).toBe(claimHash);
      expect(entry.recallCount).toBe(1);
      expect(readEntrySnippet(entry).length).toBeLessThanOrEqual(maxSnippetChars);
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

      expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
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

      expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
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

      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
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

      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("ignores raw session and transcript snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "session recap",
        results: [
          {
            path: "memory/2026-06-18.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.92,
            snippet:
              "Session: 2026-06-18 10:37:05 EDT; Session Key: agent:cody:discord:channel:1502199757592989836; Session ID: 6d52b6a2-a2e1-4839-a69a-a532b9090a6d; Source: discord",
          },
          {
            path: "memory/2026-06-18.md",
            source: "memory",
            startLine: 2,
            endLine: 2,
            score: 0.91,
            snippet: "Conversation Summary: assistant: Traced all three. No changes made.",
          },
          {
            path: "memory/2026-06-18.md",
            source: "memory",
            startLine: 3,
            endLine: 3,
            score: 0.9,
            snippet:
              "user: Save important context from this session to the daily memory file. STRICT RULES: 1. The file MUST be named exactly memory/2026-06-18.md",
          },
        ],
      });

      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("ignores already-promoted score metadata snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "promotion metadata",
        results: [
          {
            path: "memory/2026-06-18.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet:
              "2026-06-13 09:20 America/New_York - Polycore PR #112 re-review... [score=0.837 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
          },
        ],
      });

      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
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

      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
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

      const raw = JSON.stringify(
        await testing.readRecallStore(workspaceDir, new Date().toISOString()),
      );
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

  it("keeps duplicate daily signals from refreshing recall freshness", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-04-03",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-04-05",
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.62,
            snippet: "Added primary issue extraction for pain notifications.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-04-03",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-04-05",
        nowMs: Date.parse("2026-04-05T11:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.62,
            snippet: "Added primary issue extraction for pain notifications.",
            source: "memory",
          },
        ],
      });

      const [entry] = Object.values(await readRecallStoreEntries(workspaceDir));
      expect(entry?.dailyCount).toBe(1);
      expect(entry?.lastRecalledAt).toBe("2026-04-05T10:00:00.000Z");
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
      let candidateKey;

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

  it("reads only light-staged keys that have not already gone through REM", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "phase pipeline",
        nowMs,
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
          {
            path: "memory/2026-04-02.md",
            startLine: 1,
            endLine: 1,
            score: 0.91,
            snippet: "Document the Ollama setup.",
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
      const staleKey = requireCandidateKey(
        ranked.find((entry) => entry.path === "memory/2026-04-01.md"),
        "stale candidate",
      );
      const pendingKey = requireCandidateKey(
        ranked.find((entry) => entry.path === "memory/2026-04-02.md"),
        "pending candidate",
      );

      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: [staleKey],
        nowMs: nowMs - 60_000,
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [staleKey],
        nowMs,
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: [pendingKey],
        nowMs: nowMs + 60_000,
      });

      await expect(readLightStagedKeys({ workspaceDir, nowMs: nowMs + 120_000 })).resolves.toEqual(
        new Set([pendingKey]),
      );

      await recordRemConsideredPhaseSignals({
        workspaceDir,
        keys: [pendingKey],
        nowMs: nowMs + 180_000,
      });

      await expect(readLightStagedKeys({ workspaceDir, nowMs: nowMs + 240_000 })).resolves.toEqual(
        new Set(),
      );
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

      const phaseStore = await testing.readPhaseSignalStore(
        workspaceDir,
        new Date(nowMs).toISOString(),
      );
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

  it("updates existing phase-signal rows without dropping prior signal counts", async () => {
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

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      const key = ranked[0]?.key;
      expect(key).toBeTruthy();
      if (!key) {
        throw new Error("expected ranked candidate key");
      }

      await testing.writeRawPhaseSignalStore(workspaceDir, {
        version: 1,
        updatedAt: "2026-04-01T10:00:00.000Z",
        entries: {
          [key]: {
            key,
            lightHits: 2,
            remHits: 1,
            lastLightAt: "2026-04-01T10:00:00.000Z",
            lastRemAt: "2026-04-02T10:00:00.000Z",
          },
        },
      });

      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [key],
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });

      const phaseStore = await testing.readPhaseSignalStore(
        workspaceDir,
        "2026-04-05T10:00:00.000Z",
      );
      expect(phaseStore.entries[key]?.lightHits).toBe(2);
      expect(phaseStore.entries[key]?.remHits).toBe(2);
    });
  });

  it("keeps recall stats when phase-signal state cannot be read", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier cadence",
        nowMs,
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

      const env = { ...process.env };
      configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
        if (options.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
          throw new Error("phase state unavailable");
        }
        return createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
      });
      try {
        const stats = await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs });
        expect(stats.shortTermCount).toBe(1);
        expect(stats.recallSignalCount).toBe(1);
        expect(stats.phaseSignalCount).toBe(0);
        expect(stats.phaseSignalError).toContain("phase state unavailable");
      } finally {
        await configureMemoryCoreDreamingStateForTests();
      }
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

      const rawStore = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      for (const entry of Object.values(rawStore.entries)) {
        delete entry.promotedAt;
      }
      await testing.writeRawRecallStore(workspaceDir, rawStore);

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

  it("does not re-append promoted candidates whose marker key path contains spaces", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNoteInSubdir(workspaceDir, "project alpha", "2026-04-01", [
        "alpha",
        "The project alpha gateway should stay loopback-only on port 18789.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "project alpha gateway",
        results: [
          {
            path: "memory/project alpha/2026-04-01.md",
            startLine: 2,
            endLine: 2,
            score: 0.95,
            snippet: "The project alpha gateway should stay loopback-only on port 18789.",
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
      expect(ranked.map((candidate) => candidate.key)).toContain(
        "memory:memory/project alpha/2026-04-01.md:2:2",
      );

      const firstApply = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(firstApply.applied).toBe(1);
      expect(firstApply.appended).toBe(1);

      const rawStore = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      for (const entry of Object.values(rawStore.entries)) {
        delete entry.promotedAt;
      }
      await testing.writeRawRecallStore(workspaceDir, rawStore);

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
      expect(memoryText).toContain(
        "<!-- openclaw-memory-promotion:memory:memory/project alpha/2026-04-01.md:2:2 -->",
      );
      expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
      expect(
        memoryText.match(/The project alpha gateway should stay loopback-only on port 18789\./g)
          ?.length,
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
            signalCount: 1,
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
      await testing.writeRawRecallStore(workspaceDir, {
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
      });

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
      testing.isContaminatedDreamingSnippet(
        "@@ -1,1 - Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("treats bracket-prefixed dreaming snippets as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "([ Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("does not treat ordinary candidate notes with daily-memory evidence as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "Candidate: move backups weekly. confidence: 0.76 evidence: memory/2026-04-08.md:1-1",
      ),
    ).toBe(false);
  });

  it("treats transcript-style dreaming prompt echoes as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "[main/dreaming-narrative-light.jsonl#L1] User: Write a dream diary entry from these memory fragments:",
      ),
    ).toBe(true);
  });

  it("treats snippets with metadata prefix before the Candidate marker as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "- - status: staged - Candidate: User: [cron:26fb656d] run thing - confidence: 0.00 - evidence: memory/.dreams/session-corpus/2026-04-12.txt:25-25 - recalls: 0 - status: staged",
      ),
    ).toBe(true);
  });

  it("treats snippets with confidence prefix before the Candidate marker as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "confidence: 0.58 - Candidate: Assistant: Mason shipped the enforcement pass. - evidence: memory/.dreams/session-corpus/2026-04-11.txt:167-167 - recalls: 0 - status: staged",
      ),
    ).toBe(true);
  });

  it("treats raw session metadata snippets as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "Session: 2026-06-18 10:37:05 EDT; Session Key: agent:cody:discord:channel:1502199757592989836; Session ID: 6d52b6a2-a2e1-4839-a69a-a532b9090a6d; Source: discord",
      ),
    ).toBe(true);
  });

  it("treats raw conversation summaries as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "Conversation Summary: assistant: Traced all three. No changes made.",
      ),
    ).toBe(true);
  });

  it("treats raw transcript turns as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "user: Save important context from this session to the daily memory file. STRICT RULES: 1. The file MUST be named exactly memory/2026-06-18.md",
      ),
    ).toBe(true);
  });

  it("treats promotion score metadata as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "Polycore PR #112 re-review... [score=0.837 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
      ),
    ).toBe(true);
  });

  it("treats legacy and signals= promotion annotations as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
        "Legacy annotation [score=0.837 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
      ),
    ).toBe(true);
    expect(
      testing.isContaminatedDreamingSnippet(
        "New annotation [score=0.837 signals=7 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
      ),
    ).toBe(true);
  });

  it("does not treat prose that mentions the word Candidate as contaminated", () => {
    expect(
      testing.isContaminatedDreamingSnippet(
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
      expect(testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(true);
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
      expect(testing.lineRangeOverlapsDreamingFence(lines, 2, 2)).toBe(false);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(false);
    });

    it("returns true when the range straddles a fence boundary", () => {
      const lines = [
        "real line 1",
        "<!-- openclaw:dreaming:diary:start -->",
        "dream line",
        "<!-- openclaw:dreaming:diary:end -->",
        "real line 5",
      ];
      expect(testing.lineRangeOverlapsDreamingFence(lines, 2, 4)).toBe(true);
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
      expect(testing.lineRangeOverlapsDreamingFence(lines, 4, 4)).toBe(false);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 8, 8)).toBe(false);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 6, 6)).toBe(true);
    });

    // Marker lines themselves carry managed-block content. A relocated range
    // that includes a `<!-- openclaw:dreaming:*:start/end -->` marker would
    // build its snippet from raw lines that contain that marker text, leaking
    // it into MEMORY.md alongside any adjacent fenced content captured by the
    // same window. The guard treats marker lines as inside-fence so those
    // ranges are rejected. (#80613)
    it("returns true when the range ends on a Light Sleep start marker", () => {
      const lines = [
        "## Plan",
        "- Plan switches use exRule, not abConfig",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: staged dream",
        "<!-- openclaw:dreaming:light:end -->",
      ];
      expect(testing.lineRangeOverlapsDreamingFence(lines, 2, 5)).toBe(true);
    });

    it("returns true when the range begins on a Light Sleep end marker", () => {
      const lines = [
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: staged dream",
        "<!-- openclaw:dreaming:light:end -->",
        "- normal durable bullet",
      ];
      expect(testing.lineRangeOverlapsDreamingFence(lines, 3, 4)).toBe(true);
    });

    it("returns true when the range covers only a marker line", () => {
      const lines = [
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: staged dream",
        "<!-- openclaw:dreaming:light:end -->",
      ];
      expect(testing.lineRangeOverlapsDreamingFence(lines, 1, 1)).toBe(true);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 3, 3)).toBe(true);
    });

    it("returns true for REM marker single-line ranges even with no body between markers", () => {
      const lines = [
        "real line 1",
        "<!-- openclaw:dreaming:rem:start -->",
        "<!-- openclaw:dreaming:rem:end -->",
        "real line 4",
      ];
      // No content between the markers, but the marker text itself must not
      // ride along into a promoted snippet.
      expect(testing.lineRangeOverlapsDreamingFence(lines, 2, 2)).toBe(true);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 3, 3)).toBe(true);
      // Real-content single lines remain unflagged.
      expect(testing.lineRangeOverlapsDreamingFence(lines, 1, 1)).toBe(false);
      expect(testing.lineRangeOverlapsDreamingFence(lines, 4, 4)).toBe(false);
    });
  });

  it("does not promote rehydrated candidates whose relocated range covers a managed dreaming fence marker line (#80613)", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      // Daily note: human content + a managed Light Sleep block. The relevant
      // surface is the marker lines (5 and 8), not the fenced content between
      // them. The existing fence-overlap guard already blocks ranges between
      // the markers; this test exercises the residual edge case where the
      // relocated range covers a marker line itself.
      await writeDailyMemoryNote(workspaceDir, "2026-05-18", [
        "## Plan", // 1
        "- Plan switches use exRule, not abConfig", // 2
        "", // 3
        "## Light Sleep", // 4
        "<!-- openclaw:dreaming:light:start -->", // 5
        "- Candidate: staged dream", // 6
        "  - confidence: 0.95", // 7
        "<!-- openclaw:dreaming:light:end -->", // 8
      ]);

      // Stored recall snippet equals the marker text exactly, so relocate's
      // exact-match path resolves to (5, 5) with the marker as its snippet.
      // The contamination predicate does not flag bare marker text (no
      // Candidate/Reflections + confidence + evidence + status: staged +
      // recalls signature), so the only line of defense is the fence-overlap
      // guard. Pre-patch the guard returns false for a marker-only range and
      // the marker text leaks into MEMORY.md; post-patch the range is rejected.
      await recordShortTermRecalls({
        workspaceDir,
        query: "marker-line edge case",
        results: [
          {
            path: "memory/2026-05-18.md",
            startLine: 5,
            endLine: 5,
            score: 0.94,
            snippet: "<!-- openclaw:dreaming:light:start -->",
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
      const memoryText = await fs
        .readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")
        .catch(() => "");
      expect(memoryText).not.toContain("Promoted From Short-Term Memory");
      expect(memoryText).not.toMatch(/openclaw:dreaming/i);
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
            signalCount: 3,
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
            signalCount: 3,
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
            signalCount: 4,
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

  it("does not double-prefix promoted snippets that are already markdown bullets", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "- Gateway binds loopback and port 18789",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway host",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 2,
            endLine: 2,
            score: 0.92,
            snippet: "- Gateway binds loopback and port 18789",
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
      expect(memoryText).toContain("- Gateway binds loopback and port 18789");
      expect(memoryText).not.toContain("- - Gateway binds loopback and port 18789");
    });
  });

  it("keeps promoted MEMORY.md entries compact while preserving provenance", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const longDailyEntry = [
        "HanJammer reviewed the dashboard state and asked for durable memory hygiene.",
        "The raw daily note also included implementation chatter, transient timings, repeated troubleshooting detail, and operational narration that should not be copied wholesale into MEMORY.md.",
        "A curated long-term memory entry should preserve the stable conclusion without hauling the whole daily journal line into bootstrap context.",
        "Extra filler keeps this source entry long enough to prove promotion output is bounded before it reaches the root memory file.",
      ].join(" ");
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [longDailyEntry]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "memory hygiene",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.92,
            snippet: longDailyEntry,
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
        maxPromotedSnippetTokens: 55,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      const promotedLine = memoryText
        .split("\n")
        .find((line) => line.startsWith("- HanJammer reviewed the dashboard state"));
      expect(promotedLine).toBeDefined();
      expect(promotedLine?.length).toBeLessThan(340);
      expect(promotedLine).toContain("...");
      expect(promotedLine).toMatch(
        /\[score=0\.\d{3} signals=1 recalls=1 avg=0\.\d{3} source=memory\/2026-04-01\.md:1-1\]/,
      );
      expect(memoryText).toMatch(/<!-- openclaw-memory-promotion:[^\n]+ -->/);
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

  it("rehydrates daily-ingested heading-prefixed list snippets from the live note", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## 模型切换 (16:23)",
        "- **需求**: 用户想使用小米 Mimo 模型作为默认",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(4);
      expect(applied.appliedCandidates[0]?.endLine).toBe(4);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("memory/2026-05-28.md:4-4");
      expect(memoryText).toContain("模型切换 (16:23): **需求**");
    });
  });

  it("rehydrates daily-ingested multi-line list snippets from the full live note range", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## 模型切换 (16:23)",
        "- **需求**: 用户想使用小米 Mimo 模型作为默认",
        "- **偏好**: 保持低成本默认路由",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 5,
            score: 0.91,
            snippet:
              "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认; **偏好**: 保持低成本默认路由",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(4);
      expect(applied.appliedCandidates[0]?.endLine).toBe(5);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认; **偏好**: 保持低成本默认路由",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("memory/2026-05-28.md:4-5");
      expect(memoryText).toContain("模型切换 (16:23): **需求**");
      expect(memoryText).toContain("**偏好**: 保持低成本默认路由");
    });
  });

  it("rebuilds heading context from the live note during list rehydration", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## New model routing (16:23)",
        "- Keep Xiaomi Mimo as the low-cost default.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: "Old model routing: Keep Xiaomi Mimo as the low-cost default.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "New model routing (16:23): Keep Xiaomi Mimo as the low-cost default.",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("New model routing (16:23)");
      expect(memoryText).not.toContain("Old model routing");
    });
  });

  it("does not rehydrate heading-prefixed list snippets without a live body", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Model routing",
        "",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: "Model routing: Keep Xiaomi Mimo as the low-cost default.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(0);
    });
  });

  it("does not add heading context to ordinary list-item rehydration", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Model routing",
        "- Keep Xiaomi Mimo as the low-cost default.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: "Keep Xiaomi Mimo as the low-cost default.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "Keep Xiaomi Mimo as the low-cost default.",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).not.toContain("Model routing: Keep Xiaomi");
    });
  });

  it("rehydrates capped heading-prefixed list snippets from the live note", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const longBody = `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(80)}`.trim();
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Long model routing",
        `- ${longBody}`,
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: `Long model routing: ${longBody}`.slice(0, 280).replace(/\s+/g, " ").trim(),
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(4);
      expect(applied.appliedCandidates[0]?.endLine).toBe(4);
      expect(applied.appliedCandidates[0]?.snippet).toContain(
        "Long model routing: Keep Xiaomi Mimo",
      );
    });
  });

  it("rehydrates capped heading-prefixed list snippets after the heading changes", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const longBody = `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(80)}`.trim();
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## New model routing",
        `- ${longBody}`,
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 4,
            score: 0.91,
            snippet: `Old model routing: ${longBody}`.slice(0, 280).replace(/\s+/g, " ").trim(),
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet).toContain(
        "New model routing: Keep Xiaomi Mimo",
      );
      expect(applied.appliedCandidates[0]?.snippet).not.toContain("Old model routing");
    });
  });

  it("keeps renamed heading fallback bound to colon-prefixed list bodies", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Nearby shortcut",
        "- use Mimo",
        "",
        "## New model routing",
        "- **需求**: use Mimo",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 7,
            endLine: 7,
            score: 0.91,
            snippet: "Old model routing: **需求**: use Mimo",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(7);
      expect(applied.appliedCandidates[0]?.endLine).toBe(7);
      expect(applied.appliedCandidates[0]?.snippet).toBe("New model routing: **需求**: use Mimo");
      expect(applied.appliedCandidates[0]?.snippet).not.toContain("Nearby shortcut");
    });
  });

  it("preserves the full range for capped heading-prefixed multi-line list snippets", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxDailySnippetChars = 280;
      const firstListItem =
        `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(12)}`.trim();
      const secondListItem =
        `Preserve the fallback routing note when the ingestion cap cuts this chunk ${"tail ".repeat(
          42,
        )}`.trim();
      const fullIngestedSnippet = `Long model routing: ${firstListItem}; ${secondListItem}`
        .replace(/\s+/g, " ")
        .trim();
      const ingestedSnippet = fullIngestedSnippet
        .slice(0, maxDailySnippetChars)
        .replace(/\s+/g, " ")
        .trim();
      expect(ingestedSnippet.length).toBeLessThan(fullIngestedSnippet.length);

      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Long model routing",
        `- ${firstListItem}`,
        `- ${secondListItem}`,
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 4,
            endLine: 5,
            score: 0.91,
            snippet: ingestedSnippet,
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.startLine).toBe(4);
      expect(applied.appliedCandidates[0]?.endLine).toBe(5);
      expect(applied.appliedCandidates[0]?.snippet).toContain(firstListItem);
      expect(applied.appliedCandidates[0]?.snippet).toContain(secondListItem);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("memory/2026-05-28.md:4-5");
      expect(memoryText).toContain(secondListItem);
    });
  });

  it("does not reintroduce generic daily headings during list rehydration", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Model routing",
        "- Keep Xiaomi Mimo as the low-cost default.",
        "",
        "## Morning",
        "- Reviewed travel timing before the workshop.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 7,
            endLine: 7,
            score: 0.91,
            snippet: "Reviewed travel timing before the workshop.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "Reviewed travel timing before the workshop.",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).not.toContain("Morning:");
      expect(memoryText).not.toContain("Model routing: Reviewed travel timing");
    });
  });

  it("does not reintroduce managed dreaming headings during list rehydration", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
        "# 2026-05-28",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: scratch reflection",
        "<!-- openclaw:dreaming:light:end -->",
        "- Reviewed travel timing before the workshop.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "__dreaming_daily__:2026-05-28",
        signalType: "daily",
        dedupeByQueryPerDay: true,
        dayBucket: "2026-05-28",
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 7,
            endLine: 7,
            score: 0.91,
            snippet: "Reviewed travel timing before the workshop.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet).toBe(
        "Reviewed travel timing before the workshop.",
      );
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).not.toContain("Light Sleep:");
    });
  });

  it("keeps rehydrated promotion snippets capped in the recall store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
      const longSnippet = `Moved backup policy ${"x".repeat(maxSnippetChars + 100)}`;
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["intro", longSnippet]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "backup policy",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet: longSnippet,
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
      const candidateKey = requireCandidateKey(ranked[0], "long rehydrated");
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.snippet.length).toBeGreaterThan(maxSnippetChars);
      const entries = await readRecallStoreEntries(workspaceDir);
      const storedSnippet = readEntrySnippet(entries[candidateKey] ?? {});
      expect(storedSnippet.length).toBeLessThanOrEqual(maxSnippetChars);
      expect(storedSnippet).toBe(applied.appliedCandidates[0]?.snippet.slice(0, maxSnippetChars));
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
            signalCount: 2,
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
      await testing.writeRawRecallStore(workspaceDir, {
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
      });
      await testing.writeShortTermLock(workspaceDir, {
        owner: "999999:0",
        acquiredAt: Date.now() - 120_000,
      });

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

      const repairedRaw = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(repairedRaw.entries.good?.conceptTags).toContain("router");
      expect(repairedRaw.entries.good?.recallDays).toEqual(["2026-04-04"]);
    });
  });

  it("audits and repairs oversized recall stores", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
      const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
      await testing.writeRawRecallStore(workspaceDir, {
        version: 1,
        updatedAt: "2026-04-04T00:00:00.000Z",
        entries: Object.fromEntries(
          Array.from({ length: maxEntries + 3 }, (_, index) => [
            `entry-${index}`,
            {
              key: `entry-${index}`,
              path: "memory/2026-04-01.md",
              startLine: index + 1,
              endLine: index + 1,
              source: "memory",
              snippet: `Oversized recall ${index} ${"x".repeat(maxSnippetChars + 100)}`,
              recallCount: 1,
              dailyCount: 0,
              groundedCount: 0,
              totalScore: index,
              maxScore: 0.75,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: new Date(
                Date.parse("2026-04-01T00:00:00.000Z") + index,
              ).toISOString(),
              queryHashes: [`q-${index}`],
              recallDays: ["2026-04-01"],
              conceptTags: [],
            },
          ]),
        ),
      });

      const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditBefore.entryCount).toBe(maxEntries + 3);
      expect(auditBefore.issues.map((issue) => issue.code)).toContain("recall-store-over-limit");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedOverflowEntries).toBe(3);

      const entries = Object.values(await readRecallStoreEntries(workspaceDir));
      expect(entries).toHaveLength(maxEntries);
      expect(entries.every((entry) => readEntrySnippet(entry).length <= maxSnippetChars)).toBe(
        true,
      );
      expect(
        entries.some((entry) => readEntrySnippet(entry).startsWith("Oversized recall 0 ")),
      ).toBe(false);
    });
  });

  it("uses score tie-breakers when retention timestamps are invalid", () => {
    const entry = {
      key: "lower-score",
      path: "memory/2026-04-01.md",
      startLine: 1,
      endLine: 1,
      source: "memory" as const,
      snippet: "Invalid timestamp recall",
      recallCount: 1,
      dailyCount: 0,
      groundedCount: 0,
      totalScore: 1,
      maxScore: 0.75,
      firstRecalledAt: "not-a-date",
      lastRecalledAt: "not-a-date",
      queryHashes: ["q"],
      recallDays: ["2026-04-01"],
      conceptTags: [],
    };
    const higherScoreEntry = { ...entry, key: "higher-score", totalScore: 2 };

    expect([entry, higherScoreEntry].toSorted(testing.compareShortTermRecallRetention)).toEqual([
      higherScoreEntry,
      entry,
    ]);
  });

  it("rejects long contaminated legacy recall entries before truncating snippets", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
      await testing.writeRawRecallStore(workspaceDir, {
        version: 1,
        updatedAt: "2026-04-04T00:00:00.000Z",
        entries: {
          contaminated: {
            key: "contaminated",
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: `Candidate: ${"x".repeat(maxSnippetChars + 100)} confidence: 9 evidence: memory/.dreams/session-corpus/2026-04-01.txt status: staged recalls: 1`,
            recallCount: 1,
            dailyCount: 0,
            groundedCount: 0,
            totalScore: 1,
            maxScore: 0.75,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            lastRecalledAt: "2026-04-01T00:00:00.000Z",
            queryHashes: ["q"],
            recallDays: ["2026-04-01"],
            conceptTags: [],
          },
        },
      });

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.removedInvalidEntries).toBe(1);
      expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
    });
  });

  it("leaves empty recall stores normalized without rewriting", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(false);
      expect(repair.rewroteStore).toBe(false);
      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(store.version).toBe(1);
      expect(store.entries).toEqual({});
    });
  });

  it("does not rewrite an already normalized healthy recall store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Gateway host uses qmd vector search for router notes.";
      const raw = {
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
            conceptTags: testing.deriveConceptTags({
              path: "memory/2026-04-01.md",
              snippet,
            }),
          },
        },
      };
      await testing.writeRawRecallStore(workspaceDir, raw);

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(false);
      expect(repair.rewroteStore).toBe(false);
      expect(await testing.readRecallStore(workspaceDir, new Date().toISOString())).toEqual(raw);
    });
  });

  it("waits for an active short-term lock before repairing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await testing.writeRawRecallStore(workspaceDir, {
        version: 1,
        updatedAt: "2026-04-04T00:00:00.000Z",
        entries: {
          bad: {
            path: "",
          },
        },
      });
      await testing.writeShortTermLock(workspaceDir, {
        owner: `${process.pid}:${Date.now()}`,
        acquiredAt: Date.now(),
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let settled = false;
        const repairPromise = repairShortTermPromotionArtifacts({ workspaceDir }).then((result) => {
          settled = true;
          return result;
        });

        await vi.advanceTimersByTimeAsync(41);
        expect(settled).toBe(false);

        await testing.deleteShortTermLock(workspaceDir);
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

  it("reports stale sqlite locks as repairable audit issues", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await testing.writeShortTermLock(workspaceDir, {
        owner: "999999:0",
        acquiredAt: Date.now() - 120_000,
      });
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.issues.find((issue) => issue.code === "recall-lock-stale")).toStrictEqual({
        severity: "warn",
        code: "recall-lock-stale",
        message: "Short-term promotion lock appears stale.",
        fixable: true,
      });
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
      testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Move backups to S3 Glacier and sync QMD router notes.",
      }),
      // "s3" is a protected-glossary term; it now surfaces as a standalone token past the
      // per-script min-length gate (the longer terms still match as substrings).
    ).toStrictEqual(["backup", "backups", "glacier", "qmd", "router", "s3", "sync"]);
  });

  it("extracts multilingual concept tags across latin and cjk snippets", () => {
    expect(
      testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Configuración du routeur et sauvegarde Glacier.",
      }),
    ).toStrictEqual(["glacier", "sauvegarde", "routeur", "configuración"]);
    expect(
      testing.deriveConceptTags({
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
  it("shows signalCount instead of just recallCount in promotion annotations", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-05-28T10:00:00.000Z");
      const snippet = "Entry with dailyCount signals but zero recallCount.";
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", [snippet]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "test signal count display",
        nowMs,
        results: [
          {
            path: "memory/2026-05-28.md",
            startLine: 1,
            endLine: 1,
            score: 0.85,
            snippet,
            source: "memory",
          },
        ],
      });

      const store = await testing.readRecallStore(workspaceDir, new Date(nowMs).toISOString());
      const entryKey = Object.keys(store.entries)[0];
      store.entries[entryKey].dailyCount = 6;
      store.entries[entryKey].recallCount = 0;
      store.entries[entryKey].groundedCount = 1;
      await testing.writeRawRecallStore(workspaceDir, store);

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });

      expect(ranked.length).toBe(1);
      expect(ranked[0].recallCount).toBe(0);
      expect(ranked[0].dailyCount).toBe(6);
      expect(ranked[0].groundedCount).toBe(1);
      expect(ranked[0].signalCount).toBe(7);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");

      expect(memoryText).toContain("signals=7");
      expect(memoryText).toContain("recalls=0");
      expect(memoryText).not.toMatch(/recalls=7/);
    });
  });

  describe("UTF-16 snippet bounds", () => {
    it("stores a complete-code-point short-term recall snippet", async () => {
      await withTempWorkspace(async (workspaceDir) => {
        const prefix = "y".repeat(testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS - 1);
        await recordShortTermRecalls({
          workspaceDir,
          query: "utf16 recall",
          results: [
            {
              path: "memory/2026-04-03.md",
              source: "memory",
              startLine: 1,
              endLine: 1,
              score: 0.9,
              snippet: `${prefix}🚀tail`,
            },
          ],
        });

        const entries = Object.values(await readRecallStoreEntries(workspaceDir));
        expect(entries).toHaveLength(1);
        expect(readEntrySnippet(entries[0])).toBe(prefix);
      });
    });

    it("writes a complete-code-point promoted MEMORY.md snippet", async () => {
      await withTempWorkspace(async (workspaceDir) => {
        const prefix = "a".repeat(7);
        const snippet = `${prefix}🚀tail`;
        await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
        await recordShortTermRecalls({
          workspaceDir,
          query: "utf16 promotion",
          results: [
            {
              path: "memory/2026-04-03.md",
              source: "memory",
              startLine: 1,
              endLine: 1,
              score: 0.9,
              snippet,
            },
          ],
        });
        const ranked = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
        });

        await applyShortTermPromotions({
          workspaceDir,
          candidates: ranked,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          maxPromotedSnippetTokens: 2,
        });

        const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
        expect(memoryText).toContain(`- ${prefix}... [`);
        expect(memoryText).not.toContain("🚀");
      });
    });
  });
});
