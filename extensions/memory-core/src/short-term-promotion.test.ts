// Memory Core tests cover short term promotion plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import { deriveConceptTags } from "./concept-vocabulary.js";
import { isPromotionOriginBlocked } from "./dreaming-consolidation-candidates.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

import {
  configureMemoryCoreDreamingState,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
} from "./dreaming-state.js";
import {
  deleteShortTermLockEntryIfCurrent,
  withMemoryWorkspaceLock,
} from "./memory-workspace-lock.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  filterLiveShortTermRecallEntries,
  loadShortTermPromotionDreamingStats,
  recordGroundedShortTermCandidates,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
  recordShortTermRecalls,
  readLightStagedKeys,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

type RecordRecallParams = Parameters<typeof recordShortTermRecalls>[0];
type RecallResult = RecordRecallParams["results"][number];
type RecallResultExtras = Partial<
  Omit<RecallResult, "path" | "startLine" | "endLine" | "score" | "snippet" | "source">
>;
type RankAllOptions = Omit<
  Parameters<typeof rankShortTermPromotionCandidates>[0],
  "workspaceDir" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;
type ApplyAllOptions = Omit<
  Parameters<typeof applyShortTermPromotions>[0],
  "workspaceDir" | "candidates" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;
type PromotionCandidate = Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>[number];
type GroundedCandidateFixture = Parameters<
  typeof recordGroundedShortTermCandidates
>[0]["items"][number];
type PromotionCandidateFixture = Pick<
  PromotionCandidate,
  "key" | "path" | "startLine" | "endLine" | "source" | "snippet"
> &
  Partial<PromotionCandidate>;

const allPromotionThresholds = {
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
} as const;

function memoryRecallResult(
  memoryPath: string,
  startLine: number,
  endLine: number,
  score: number,
  snippet: string,
  extras: RecallResultExtras = {},
): RecallResult {
  return { ...extras, path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

function recordMemoryRecalls(
  workspaceDir: string,
  query: string,
  results: RecallResult[],
  options: Omit<RecordRecallParams, "workspaceDir" | "query" | "results"> = {},
): Promise<void> {
  return recordShortTermRecalls({ ...options, workspaceDir, query, results });
}

function rankAllCandidates(workspaceDir: string, options: RankAllOptions = {}) {
  return rankShortTermPromotionCandidates({ ...options, workspaceDir, ...allPromotionThresholds });
}

function applyAllCandidates(
  workspaceDir: string,
  candidates: Parameters<typeof applyShortTermPromotions>[0]["candidates"],
  options: ApplyAllOptions = {},
) {
  return applyShortTermPromotions({
    ...options,
    workspaceDir,
    candidates,
    ...allPromotionThresholds,
  });
}

function promotionCandidateFixture(params: PromotionCandidateFixture): PromotionCandidate {
  return {
    recallCount: 3,
    signalCount: 3,
    avgScore: 0.95,
    maxScore: 0.95,
    uniqueQueries: 2,
    firstRecalledAt: "2026-04-01T00:00:00.000Z",
    lastRecalledAt: "2026-04-02T00:00:00.000Z",
    ageDays: 0,
    score: 0.95,
    recallDays: ["2026-04-01", "2026-04-02"],
    conceptTags: [],
    components: {
      frequency: 1,
      relevance: 1,
      diversity: 1,
      recency: 1,
      consolidation: 1,
      conceptual: 1,
    },
    ...params,
  };
}

function recallStoreEntryFixture(
  params: Pick<ShortTermRecallEntry, "key" | "path"> & Partial<ShortTermRecallEntry>,
): ShortTermRecallEntry {
  return {
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `${params.key} recall`,
    recallCount: 2,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 1.8,
    maxScore: 0.95,
    firstRecalledAt: "2026-04-01T00:00:00.000Z",
    lastRecalledAt: "2026-04-04T00:00:00.000Z",
    queryHashes: ["a", "b"],
    recallDays: ["2026-04-04"],
    conceptTags: [],
    ...params,
  };
}

function groundedCandidateFixture(
  params: Pick<GroundedCandidateFixture, "path" | "snippet" | "query"> &
    Partial<GroundedCandidateFixture>,
): GroundedCandidateFixture {
  return {
    startLine: 1,
    endLine: 1,
    score: 0.9,
    signalCount: 1,
    dayBucket: "2026-04-03",
    ...params,
  };
}

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

  type WorkspaceTest = (title: string, run: (workspaceDir: string) => Promise<void>) => void;
  const it: WorkspaceTest & Pick<typeof baseIt, "runIf"> = Object.assign(
    (title: string, run: (workspaceDir: string) => Promise<void>) =>
      baseIt(title, async () => {
        await withTempWorkspace(run);
      }),
    { runIf: baseIt.runIf },
  );

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  async function promoteDailyHeadingSnippet(
    workspaceDir: string,
    params: { snippet: string; startLine?: number; endLine?: number },
  ) {
    const startLine = params.startLine ?? 4;
    await recordMemoryRecalls(
      workspaceDir,
      "__dreaming_daily__:2026-05-28",
      [
        memoryRecallResult(
          "memory/2026-05-28.md",
          startLine,
          params.endLine ?? startLine,
          0.91,
          params.snippet,
        ),
      ],
      { signalType: "daily", dedupeByQueryPerDay: true, dayBucket: "2026-05-28" },
    );
    const nowMs = Date.parse("2026-05-31T00:00:00.000Z");
    return await applyAllCandidates(
      workspaceDir,
      await rankAllCandidates(workspaceDir, { nowMs }),
      { nowMs },
    );
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

  async function seedGatewayPromotionCandidate(workspaceDir: string) {
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
    await recordMemoryRecalls(workspaceDir, "gateway host", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        10,
        12,
        0.92,
        "Gateway binds loopback and port 18789",
      ),
    ]);
    return await rankAllCandidates(workspaceDir);
  }

  function recordRotateCredentialsRecall(workspaceDir: string): Promise<void> {
    return recordMemoryRecalls(
      workspaceDir,
      "rotate creds",
      [
        memoryRecallResult(
          "memory/2026-04-29.md",
          3,
          3,
          0.96,
          "Rotate the staging Postgres credentials before next deploy.",
        ),
      ],
      { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
    );
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

  async function readRecallStoreEntries(workspaceDir: string) {
    return await testing
      .readRecallStore(workspaceDir, new Date().toISOString())
      .then((store) => store.entries);
  }

  async function clearPromotedAt(workspaceDir: string): Promise<void> {
    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    for (const entry of Object.values(store.entries)) {
      delete entry.promotedAt;
    }
    await testing.writeRawRecallStore(workspaceDir, store);
  }

  function readEntrySnippet(entry: { snippet?: unknown }): string {
    return typeof entry.snippet === "string" ? entry.snippet : "";
  }

  async function expectEnoent(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toHaveProperty("code", "ENOENT");
  }

  it("records short-term recall for notes stored in a memory/ subdirectory", async (workspaceDir) => {
    const notePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "daily", "2026-04-03", [
      "Subdirectory recall integration test note.",
    ]);
    const relativePath = path.relative(workspaceDir, notePath).replaceAll("\\", "/");
    await recordMemoryRecalls(workspaceDir, "test query", [
      memoryRecallResult(relativePath, 1, 1, 0.9, "Subdirectory recall integration test note."),
    ]);
    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(Object.keys(store.entries).length).toBeGreaterThan(0);
  });

  it("deduplicates source-file checks within a recall batch", async (workspaceDir) => {
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

  it("falls back when the injected recall timestamp is outside Date range", async (workspaceDir) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const notePath = await writeDailyMemoryNote(workspaceDir, "2026-05-30", [
      "Bounded recall timestamp note.",
    ]);

    await recordMemoryRecalls(
      workspaceDir,
      "bounded recall",
      [
        memoryRecallResult(
          path.relative(workspaceDir, notePath).replaceAll("\\", "/"),
          1,
          1,
          0.9,
          "Bounded recall timestamp note.",
        ),
      ],
      { nowMs: 8_640_000_000_000_001 },
    );

    const [entry] = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entry?.firstRecalledAt).toBe("2026-05-30T12:00:00.000Z");
    expect(entry?.lastRecalledAt).toBe("2026-05-30T12:00:00.000Z");
  });

  it("records short-term recall for notes stored in spaced and Unicode memory subdirectories", async (workspaceDir) => {
    const spacedPath = await writeDailyMemoryNoteInSubdir(
      workspaceDir,
      "daily notes",
      "2026-04-03",
      ["Spaced subdirectory recall integration test note."],
    );
    const unicodePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "日记", "2026-04-04", [
      "Unicode subdirectory recall integration test note.",
    ]);

    await recordMemoryRecalls(workspaceDir, "nested subdir query", [
      memoryRecallResult(
        path.relative(workspaceDir, spacedPath).replaceAll("\\", "/"),
        1,
        1,
        0.9,
        "Spaced subdirectory recall integration test note.",
      ),
      memoryRecallResult(
        path.relative(workspaceDir, unicodePath).replaceAll("\\", "/"),
        1,
        1,
        0.85,
        "Unicode subdirectory recall integration test note.",
      ),
    ]);

    const raw = JSON.stringify(
      await testing.readRecallStore(workspaceDir, new Date().toISOString()),
    );
    expect(raw).toContain("memory/daily notes/2026-04-03.md");
    expect(raw).toContain("memory/日记/2026-04-04.md");
  });

  it("caps short-term recall store entries and snippets during normal recording", async (workspaceDir) => {
    const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await recordMemoryRecalls(
      workspaceDir,
      "bounded recall",
      Array.from({ length: maxEntries + 5 }, (_, index) =>
        memoryRecallResult(
          "memory/2026-04-03.md",
          index + 1,
          index + 1,
          0.1 + index / (maxEntries + 5),
          `Recall entry ${index} ${"x".repeat(maxSnippetChars + 100)}`,
        ),
      ),
    );

    const entries = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(maxEntries);
    expect(entries.every((entry) => readEntrySnippet(entry).length <= maxSnippetChars)).toBe(true);
    expect(entries.some((entry) => readEntrySnippet(entry).startsWith("Recall entry 0 "))).toBe(
      false,
    );
    expect(
      entries.some((entry) =>
        readEntrySnippet(entry).startsWith(`Recall entry ${maxEntries + 4} `),
      ),
    ).toBe(true);
  });

  it("keeps long-snippet claim identity stable while storing capped snippets", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    const longSnippet = `Stable claim identity ${"x".repeat(maxSnippetChars + 100)}`;

    await recordGroundedShortTermCandidates({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      items: [
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: longSnippet,
          query: "__dreaming_grounded_backfill__:candidate",
        }),
      ],
      nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    await recordMemoryRecalls(
      workspaceDir,
      "stable claim",
      [memoryRecallResult("memory/2026-04-03.md", 1, 1, 0.8, longSnippet)],
      { nowMs: Date.parse("2026-04-03T11:00:00.000Z") },
    );

    const entries = Object.entries(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(1);
    const [key, entry] = expectDefined(entries[0], "stable claim recall entry");
    const claimHash = entry.claimHash;
    if (typeof claimHash !== "string") {
      throw new Error("expected stable claim hash");
    }
    expect(key.endsWith(`:${claimHash}`)).toBe(true);
    expect(entry.claimHash).toBe(claimHash);
    expect(entry.recallCount).toBe(1);
    expect(readEntrySnippet(entry).length).toBeLessThanOrEqual(maxSnippetChars);
  });

  it("ignores dream report paths when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "dream recall", [
      memoryRecallResult(
        "memory/dreaming/deep/2026-04-03.md",
        1,
        1,
        0.9,
        "Auto-generated dream report should not seed promotions.",
      ),
    ]);

    expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
  });

  it("ignores prefixed dream report paths when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "prefixed dream recall", [
      memoryRecallResult(
        "../../vault/memory/dreaming/deep/2026-04-03.md",
        1,
        1,
        0.9,
        "External dream report should not seed promotions.",
      ),
    ]);

    expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
  });

  it("ignores contaminated dreaming snippets when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "action preference", [
      memoryRecallResult(
        "memory/2026-04-03.md",
        1,
        1,
        0.92,
        "Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ]);

    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("ignores bullet-prefixed dreaming snippets when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "action preference", [
      memoryRecallResult(
        "memory/2026-04-03.md",
        1,
        5,
        0.92,
        [
          "- Candidate: Default to action.",
          "  - confidence: 0.76",
          "  - evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1",
          "  - recalls: 3",
          "  - status: staged",
        ].join("\n"),
      ),
    ]);

    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("ignores raw session and transcript snippets when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "session recap", [
      memoryRecallResult(
        "memory/2026-06-18.md",
        1,
        1,
        0.92,
        "Session: 2026-06-18 10:37:05 EDT; Session Key: agent:cody:discord:channel:1502199757592989836; Session ID: 6d52b6a2-a2e1-4839-a69a-a532b9090a6d; Source: discord",
      ),
      memoryRecallResult(
        "memory/2026-06-18.md",
        2,
        2,
        0.91,
        "Conversation Summary: assistant: Traced all three. No changes made.",
      ),
      memoryRecallResult(
        "memory/2026-06-18.md",
        3,
        3,
        0.9,
        "user: Save important context from this session to the daily memory file. STRICT RULES: 1. The file MUST be named exactly memory/2026-06-18.md",
      ),
    ]);

    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("ignores already-promoted score metadata snippets when recording short-term recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "promotion metadata", [
      memoryRecallResult(
        "memory/2026-06-18.md",
        1,
        1,
        0.94,
        "2026-06-13 09:20 America/New_York - Polycore PR #112 re-review... [score=0.837 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
      ),
    ]);

    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("keeps ordinary snippets that only quote dreaming prompt markers", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "debug note", [
      {
        path: "memory/2026-04-03.md",
        source: "memory",
        startLine: 1,
        endLine: 1,
        score: 0.75,
        snippet:
          "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
      },
    ]);

    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    const entries = Object.values(store.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.snippet).toBe(
      "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
    );
  });

  it("records recalls and ranks candidates with weighted scores", async (workspaceDir) => {
    const shortTermResult = memoryRecallResult(
      "memory/2026-04-02.md",
      3,
      5,
      0.9,
      "Configured VLAN 10 on Omada router",
    );
    await recordMemoryRecalls(workspaceDir, "router", [
      shortTermResult,
      memoryRecallResult("MEMORY.md", 1, 1, 0.99, "Long-term note"),
    ]);
    await recordMemoryRecalls(workspaceDir, "iot vlan", [{ ...shortTermResult, score: 0.8 }]);

    const ranked = await rankAllCandidates(workspaceDir);

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

  it("preserves a project annotation from recall ingestion through promotion", async (workspaceDir) => {
    const snippet = "Use the repository release helper";
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", [`- ${snippet}`]);
    const projectResult = (projectKey: string) =>
      memoryRecallResult("memory/2026-04-02.md", 1, 1, 0.9, snippet, { projectKey });
    await recordMemoryRecalls(workspaceDir, "release helper", [
      projectResult("path:/Users/Alice/Repo"),
    ]);
    await recordMemoryRecalls(workspaceDir, "repository release", [
      projectResult("path:/Users/alice/repo"),
    ]);
    await recordMemoryRecalls(workspaceDir, "mixed case repository", [
      projectResult("github.com/OpenClaw/OpenClaw"),
    ]);
    const candidates = await rankAllCandidates(workspaceDir);
    expect(candidates[0]?.projectKey).toBe(
      "path:/Users/Alice/Repo; path:/Users/alice/repo; github.com/OpenClaw/OpenClaw",
    );

    await applyAllCandidates(workspaceDir, candidates);
    await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).resolves.toContain(
      "<!-- project: path:/Users/Alice/Repo; path:/Users/alice/repo; github.com/OpenClaw/OpenClaw -->",
    );
  });

  it("serializes concurrent recall writes so counts are not lost", async (workspaceDir) => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordMemoryRecalls(workspaceDir, `backup-${index % 4}`, [
          memoryRecallResult("memory/2026-04-03.md", 1, 2, 0.9, "Move backups to S3 Glacier."),
        ]),
      ),
    );

    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.recallCount).toBe(8);
    expect(ranked[0]?.uniqueQueries).toBe(4);
  });

  it("keeps duplicate daily signals from refreshing recall freshness", async (workspaceDir) => {
    const result = memoryRecallResult(
      "memory/2026-04-03.md",
      1,
      1,
      0.62,
      "Added primary issue extraction for pain notifications.",
    );
    const dailyOptions = {
      signalType: "daily" as const,
      dedupeByQueryPerDay: true,
      dayBucket: "2026-04-05",
    };
    await recordMemoryRecalls(workspaceDir, "__dreaming_daily__:2026-04-03", [result], {
      ...dailyOptions,
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    await recordMemoryRecalls(workspaceDir, "__dreaming_daily__:2026-04-03", [result], {
      ...dailyOptions,
      nowMs: Date.parse("2026-04-05T11:00:00.000Z"),
    });

    const [entry] = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entry?.dailyCount).toBe(1);
    expect(entry?.lastRecalledAt).toBe("2026-04-05T10:00:00.000Z");
  });

  it("uses default thresholds for promotion", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-03.md", 1, 2, 0.96, "Move backups to S3 Glacier."),
    ]);

    const ranked = await rankShortTermPromotionCandidates({ workspaceDir });
    expect(ranked).toHaveLength(0);
  });

  it("merges a repeated claim across three day files and clears the default gates", async (workspaceDir) => {
    const queryDays = ["2026-04-01", "2026-04-02", "2026-04-03"];
    let candidateKey;

    for (const [index, day] of queryDays.entries()) {
      const nowMs = Date.parse(`${day}T10:00:00.000Z`);
      await recordMemoryRecalls(
        workspaceDir,
        `__dreaming_daily__:${day}`,
        [
          {
            path: `memory/${day}.md`,
            startLine: index + 1,
            endLine: index + 1,
            score: 0.62,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
            provenance: {
              originClass: "agent",
              sessionKind: "unknown",
              observedAt: nowMs,
            },
          },
        ],
        {
          signalType: "daily",
          dedupeByQueryPerDay: true,
          dayBucket: day,
          nowMs,
        },
      );

      const ranked = await rankAllCandidates(workspaceDir, { nowMs });
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
    expect(ranked[0]?.key).toMatch(/^memory:claim:/u);
    expect(ranked[0]?.path).toBe("memory/2026-04-01.md");
    expect(ranked[0]?.startLine).toBe(1);
    expect(ranked[0]?.recallCount).toBe(0);
    expect(ranked[0]?.dailyCount).toBe(3);
    expect(ranked[0]?.signalCount).toBe(3);
    expect(ranked[0]?.uniqueQueries).toBe(3);
    expect(ranked[0]?.recallDays).toEqual(queryDays);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0.75);
    expect(ranked[0] && isPromotionOriginBlocked(ranked[0])).toBe(false);
  });

  it("does not create a daily aggregate beside a capped interactive claim", async (workspaceDir) => {
    const longClaim = `Durable interactive claim ${"detail ".repeat(140)}`.trim();
    await recordMemoryRecalls(workspaceDir, "interactive claim", [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.9, longClaim),
    ]);
    await recordMemoryRecalls(
      workspaceDir,
      "__dreaming_daily__:2026-04-02",
      [memoryRecallResult("memory/2026-04-02.md", 3, 3, 0.62, longClaim)],
      { signalType: "daily", dayBucket: "2026-04-02" },
    );

    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ recallCount: 1, dailyCount: 1 });
    expect(ranked[0]?.key).not.toMatch(/^memory:claim:/u);
  });

  it("reads only light-staged keys that have not already gone through REM", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await recordMemoryRecalls(
      workspaceDir,
      "phase pipeline",
      [
        memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.9, "Move backups to S3 Glacier."),
        memoryRecallResult("memory/2026-04-02.md", 1, 1, 0.91, "Document the Ollama setup."),
      ],
      { nowMs },
    );
    const ranked = await rankAllCandidates(workspaceDir, { nowMs });
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

  it("lets grounded durable evidence satisfy default deep thresholds", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      'Always use "Happy Together" calendar for flights and reservations.',
    ]);

    await recordGroundedShortTermCandidates({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      items: [
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: 'Always use "Happy Together" calendar for flights and reservations.',
          score: 0.92,
          query: "__dreaming_grounded_backfill__:lasting-update",
        }),
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: 'Always use "Happy Together" calendar for flights and reservations.',
          score: 0.82,
          query: "__dreaming_grounded_backfill__:candidate",
        }),
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: 'Always use "Happy Together" calendar for flights and reservations.',
          score: 0.86,
          query: "__dreaming_grounded_backfill__:durable-fact",
        }),
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
    expect(ranked[0]?.uniqueQueries).toBe(3);
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

  it("removes grounded-only staged entries without deleting mixed live entries", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Grounded only rule.",
      "Live recall-backed rule.",
    ]);

    await recordGroundedShortTermCandidates({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      items: [
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: "Grounded only rule.",
          score: 0.92,
          query: "__dreaming_grounded_backfill__:lasting-update",
          signalCount: 2,
        }),
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          startLine: 2,
          endLine: 2,
          snippet: "Live recall-backed rule.",
          score: 0.92,
          query: "__dreaming_grounded_backfill__:lasting-update",
          signalCount: 2,
        }),
      ],
      dedupeByQueryPerDay: true,
    });
    await recordMemoryRecalls(workspaceDir, "live recall", [
      memoryRecallResult("memory/2026-04-03.md", 2, 2, 0.87, "Live recall-backed rule."),
    ]);

    const result = await removeGroundedShortTermCandidates({ workspaceDir });
    expect(result.removed).toBe(1);

    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.snippet).toContain("Live recall-backed rule");
    expect(ranked[0]?.groundedCount).toBe(2);
    expect(ranked[0]?.recallCount).toBe(1);
  });

  it("rewards spaced recalls as consolidation instead of only raw count", async (workspaceDir) => {
    const result = memoryRecallResult(
      "memory/2026-04-01.md",
      1,
      2,
      0.9,
      "Configured router VLAN 10 and IoT segment.",
    );
    await recordMemoryRecalls(workspaceDir, "router", [result], {
      nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
    });
    await recordMemoryRecalls(workspaceDir, "iot segment", [{ ...result, score: 0.88 }], {
      nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
    });

    const ranked = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.recallDays).toEqual(["2026-04-01", "2026-04-04"]);
    expect(ranked[0]?.components.consolidation).toBeGreaterThan(0.4);
  });

  it("lets recency half-life tune the temporal score", async (workspaceDir) => {
    await recordMemoryRecalls(
      workspaceDir,
      "glacier retention",
      [memoryRecallResult("memory/2026-04-01.md", 1, 2, 0.92, "Move backups to S3 Glacier.")],
      { nowMs: Date.parse("2026-04-01T10:00:00.000Z") },
    );

    const slowerDecay = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
      recencyHalfLifeDays: 14,
    });
    const fasterDecay = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
      recencyHalfLifeDays: 7,
    });

    expect(slowerDecay).toHaveLength(1);
    expect(fasterDecay).toHaveLength(1);
    expect(slowerDecay[0]?.components.recency).toBeCloseTo(0.5, 3);
    expect(fasterDecay[0]?.components.recency).toBeCloseTo(0.25, 3);
    const slowerResult = expectDefined(slowerDecay[0], "slower decay result");
    const fasterResult = expectDefined(fasterDecay[0], "faster decay result");
    expect(slowerResult.score).toBeGreaterThan(fasterResult.score);
  });

  it("boosts deep ranking when light/rem phase signals reinforce a candidate", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    const results = [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.75, "Router VLAN baseline noted."),
      memoryRecallResult("memory/2026-04-02.md", 1, 1, 0.75, "Backup policy for router snapshots."),
    ];
    await recordMemoryRecalls(workspaceDir, "router setup", results, { nowMs });
    await recordMemoryRecalls(workspaceDir, "router backup", results, { nowMs });

    const baseline = await rankAllCandidates(workspaceDir, { nowMs });
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

    const ranked = await rankAllCandidates(workspaceDir, { nowMs });
    expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
    const boostedResult = expectDefined(ranked[0], "boosted phase-signal result");
    const baselineResult = expectDefined(ranked[1], "baseline phase-signal result");
    expect(boostedResult.score).toBeGreaterThan(baselineResult.score);

    const phaseStore = await testing.readPhaseSignalStore(
      workspaceDir,
      new Date(nowMs).toISOString(),
    );
    expect(phaseStore.entries[boostedKey]?.lightHits).toBe(1);
    expect(phaseStore.entries[boostedKey]?.remHits).toBe(1);
  });

  it("weights fresh phase signals more than stale ones", async (workspaceDir) => {
    const results = [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.9, "Move backups to S3 Glacier."),
    ];
    await recordMemoryRecalls(workspaceDir, "glacier cadence", results, {
      nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
    });
    await recordMemoryRecalls(workspaceDir, "backup lifecycle", results, {
      nowMs: Date.parse("2026-04-01T12:00:00.000Z"),
    });

    const rankedBaseline = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    const key = requireCandidateKey(rankedBaseline[0], "ranked baseline");

    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "rem",
      keys: [key],
      nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
    });
    const staleSignalRank = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "rem",
      keys: [key],
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    const freshSignalRank = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });

    expect(staleSignalRank).toHaveLength(1);
    expect(freshSignalRank).toHaveLength(1);
    const freshResult = expectDefined(freshSignalRank[0], "fresh phase-signal result");
    const staleResult = expectDefined(staleSignalRank[0], "stale phase-signal result");
    expect(freshResult.score).toBeGreaterThan(staleResult.score);
  });

  it("updates existing phase-signal rows without dropping prior signal counts", async (workspaceDir) => {
    await recordMemoryRecalls(
      workspaceDir,
      "glacier cadence",
      [memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.9, "Move backups to S3 Glacier.")],
      { nowMs: Date.parse("2026-04-01T10:00:00.000Z") },
    );

    const ranked = await rankAllCandidates(workspaceDir, {
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

    const phaseStore = await testing.readPhaseSignalStore(workspaceDir, "2026-04-05T10:00:00.000Z");
    expect(phaseStore.entries[key]?.lightHits).toBe(2);
    expect(phaseStore.entries[key]?.remHits).toBe(2);
  });

  it("keeps recall stats when phase-signal state cannot be read", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await recordMemoryRecalls(
      workspaceDir,
      "glacier cadence",
      [memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.9, "Move backups to S3 Glacier.")],
      { nowMs },
    );

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

  it("keeps recent valid recall stats ahead of malformed timestamps at the entry cap", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    const malformedEntries = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const key = `malformed-${index}`;
        return [
          key,
          {
            key,
            path: `memory/2026-04-01-malformed-${index}.md`,
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: `Malformed timestamp entry ${index}`,
            recallCount: 100 - index,
            dailyCount: 0,
            groundedCount: 0,
            totalScore: 1,
            maxScore: 1,
            firstRecalledAt: "not-a-timestamp",
            lastRecalledAt: "not-a-timestamp",
            queryHashes: [],
            recallDays: [],
            conceptTags: [],
          },
        ];
      }),
    );
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-05T10:00:00.000Z",
      entries: {
        ...malformedEntries,
        recent: {
          key: "recent",
          path: "memory/2026-04-05-recent.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Recent valid timestamp entry",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 1,
          maxScore: 1,
          firstRecalledAt: "2026-04-05T09:00:00.000Z",
          lastRecalledAt: "2026-04-05T09:00:00.000Z",
          queryHashes: [],
          recallDays: [],
          conceptTags: [],
        },
      },
    });

    const stats = await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs });

    expect(stats.shortTermEntries).toHaveLength(8);
    expect(stats.shortTermEntries[0]?.path).toBe("memory/2026-04-05-recent.md");
    expect(stats.shortTermEntries[1]?.path).toBe("memory/2026-04-01-malformed-0.md");
    expect(stats.shortTermEntries.map((entry) => entry.path)).not.toContain(
      "memory/2026-04-01-malformed-7.md",
    );
  });

  it("reconciles existing promotion markers instead of appending duplicates", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "line 1",
      "line 2",
      "The gateway should stay loopback-only on port 18789.",
    ]);
    await recordMemoryRecalls(workspaceDir, "gateway loopback", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        3,
        0.95,
        "The gateway should stay loopback-only on port 18789.",
      ),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const firstApply = await applyAllCandidates(workspaceDir, ranked);
    expect(firstApply.applied).toBe(1);
    expect(firstApply.appended).toBe(1);
    expect(firstApply.reconciledExisting).toBe(0);

    await clearPromotedAt(workspaceDir);

    const secondApply = await applyAllCandidates(workspaceDir, ranked);
    expect(secondApply.applied).toBe(1);
    expect(secondApply.appended).toBe(0);
    expect(secondApply.reconciledExisting).toBe(1);

    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
    expect(memoryText.match(/The gateway should stay loopback-only on port 18789\./g)?.length).toBe(
      1,
    );
  });

  it("does not re-append promoted candidates whose marker key path contains spaces", async (workspaceDir) => {
    await writeDailyMemoryNoteInSubdir(workspaceDir, "project alpha", "2026-04-01", [
      "alpha",
      "The project alpha gateway should stay loopback-only on port 18789.",
    ]);
    await recordMemoryRecalls(workspaceDir, "project alpha gateway", [
      memoryRecallResult(
        "memory/project alpha/2026-04-01.md",
        2,
        2,
        0.95,
        "The project alpha gateway should stay loopback-only on port 18789.",
      ),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked.map((candidate) => candidate.key)).toContain(
      "memory:memory/project alpha/2026-04-01.md:2:2",
    );

    const firstApply = await applyAllCandidates(workspaceDir, ranked);
    expect(firstApply.applied).toBe(1);
    expect(firstApply.appended).toBe(1);

    await clearPromotedAt(workspaceDir);

    const secondApply = await applyAllCandidates(workspaceDir, ranked);
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

  it("filters out candidates older than maxAgeDays during ranking", async (workspaceDir) => {
    await recordMemoryRecalls(
      workspaceDir,
      "old note",
      [memoryRecallResult("memory/2026-04-01.md", 1, 2, 0.92, "Move backups to S3 Glacier.")],
      { nowMs: Date.parse("2026-04-01T10:00:00.000Z") },
    );

    const ranked = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
      maxAgeDays: 7,
    });

    expect(ranked).toHaveLength(0);
  });

  it("treats negative threshold overrides as invalid and keeps defaults", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-03.md", 1, 2, 0.96, "Move backups to S3 Glacier."),
    ]);

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: -1,
      minRecallCount: -1,
      minUniqueQueries: -1,
    });
    expect(ranked).toHaveLength(0);
  });

  it("enforces default thresholds during apply even when candidates are passed directly", async (workspaceDir) => {
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
    expect(applied.rejectedCandidates[0]?.reason).toContain("signal threshold");
  });

  it("does not rank contaminated dreaming snippets from an existing short-term store", async (workspaceDir) => {
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

    const ranked = await rankAllCandidates(workspaceDir);

    expect(ranked).toStrictEqual([]);
  });

  it("does not promote rehydrated candidates whose relocated range covers a managed dreaming fence marker line (#80613)", async (workspaceDir) => {
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
    await recordMemoryRecalls(workspaceDir, "marker-line edge case", [
      {
        path: "memory/2026-05-18.md",
        startLine: 5,
        endLine: 5,
        score: 0.94,
        snippet: "<!-- openclaw:dreaming:light:start -->",
        source: "memory",
      },
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(0);
    const memoryText = await fs
      .readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")
      .catch(() => "");
    expect(memoryText).not.toContain("Promoted From Short-Term Memory");
    expect(memoryText).not.toMatch(/openclaw:dreaming/i);
  });

  it("refuses to promote rehydrated candidates that land inside a managed dreaming fence", async (workspaceDir) => {
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

  it("skips direct candidates that exceed maxAgeDays during apply", async (workspaceDir) => {
    const applied = await applyShortTermPromotions({
      workspaceDir,
      maxAgeDays: 7,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      candidates: [
        promotionCandidateFixture({
          key: "memory:memory/2026-04-01.md:1:1",
          path: "memory/2026-04-01.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Expired short-term note.",
          ageDays: 10,
          conceptTags: ["expired"],
        }),
      ],
    });

    expect(applied.applied).toBe(0);
    expect(applied.rejectedCandidates[0]?.reason).toContain("age threshold");
    await expectEnoent(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"));
  });

  it("does not append contaminated dreaming snippets during direct apply", async (workspaceDir) => {
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
    expect(applied.rejectedCandidates[0]?.reason).toBe("contamination filter");
    await expectEnoent(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"));
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async (workspaceDir) => {
    const ranked = await seedGatewayPromotionCandidate(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);
    expect(applied.applied).toBe(1);

    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("Promoted From Short-Term Memory");
    expect(memoryText).toContain("memory/2026-04-01.md:10-10");
    expect(memoryText).toMatch(/<!-- trigger: [^\n]* --> <!-- importance: \d+ -->/u);

    const rankedAfter = await rankAllCandidates(workspaceDir);
    expect(rankedAfter).toHaveLength(0);

    const rankedIncludingPromoted = await rankAllCandidates(workspaceDir, {
      includePromoted: true,
    });
    expect(rankedIncludingPromoted).toHaveLength(1);
    expect(requirePromotedAt(rankedIncludingPromoted[0], "promoted candidate")).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("does not promote a trusted recall candidate from a quarantined daily file", async (workspaceDir) => {
    const relativePath = "memory/2026-04-01.md";
    const snippet = "Gateway binds loopback and port 18789";
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [snippet]);
    await recordMemoryRecalls(workspaceDir, "gateway host", [
      {
        path: relativePath,
        startLine: 1,
        endLine: 1,
        score: 0.92,
        snippet,
        source: "memory",
        provenance: {
          originClass: "agent",
          sessionKind: "unknown",
          observedAt: Date.parse("2026-04-01T12:00:00.000Z"),
        },
      },
    ]);
    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked[0]?.provenance?.originClass).toBe("agent");

    vi.mocked(listMemoryArtifactProvenance).mockResolvedValueOnce([
      {
        relativePath,
        provenance: {
          fileHash: "0".repeat(64),
          originClass: "untrusted",
          observedAt: Date.parse("2026-04-01T12:05:00.000Z"),
        },
      },
    ]);

    const applied = await applyAllCandidates(workspaceDir, ranked);
    expect(applied.applied).toBe(0);
    expect(applied.rejectedCandidates[0]?.reason).toBe("origin filter (untrusted)");
    await expectEnoent(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"));
  });

  it("does not double-prefix promoted snippets that are already markdown bullets", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "alpha",
      "- Gateway binds loopback and port 18789",
    ]);
    await recordMemoryRecalls(workspaceDir, "gateway host", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        2,
        2,
        0.92,
        "- Gateway binds loopback and port 18789",
      ),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("- Gateway binds loopback and port 18789");
    expect(memoryText).not.toContain("- - Gateway binds loopback and port 18789");
  });

  it("keeps promoted MEMORY.md entries compact while preserving provenance", async (workspaceDir) => {
    const longDailyEntry = [
      "HanJammer reviewed the dashboard state and asked for durable memory hygiene.",
      "The raw daily note also included implementation chatter, transient timings, repeated troubleshooting detail, and operational narration that should not be copied wholesale into MEMORY.md.",
      "A curated long-term memory entry should preserve the stable conclusion without hauling the whole daily journal line into bootstrap context.",
      "Extra filler keeps this source entry long enough to prove promotion output is bounded before it reaches the root memory file.",
    ].join(" ");
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [longDailyEntry]);
    await recordMemoryRecalls(workspaceDir, "memory hygiene", [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.92, longDailyEntry),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked, {
      maxPromotedSnippetTokens: 55,
    });

    expect(applied.applied).toBe(1);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    const promotedLine = memoryText
      .split("\n")
      .find((line) => line.startsWith("- HanJammer reviewed the dashboard state"));
    expect(promotedLine).toBeDefined();
    expect(promotedLine?.replace(/\s*<!--[\s\S]*?-->/gu, "").length).toBeLessThan(340);
    expect(promotedLine).toContain("...");
    expect(promotedLine).toMatch(
      /\[score=0\.\d{3} signals=1 recalls=1 avg=0\.\d{3} source=memory\/2026-04-01\.md:1-1\]/,
    );
    expect(memoryText).toMatch(/<!-- openclaw-memory-promotion:[^\n]+ -->/);
  });

  it("does not re-append candidates that were promoted in a prior run", async (workspaceDir) => {
    const ranked = await seedGatewayPromotionCandidate(workspaceDir);
    const first = await applyAllCandidates(workspaceDir, ranked);
    expect(first.applied).toBe(1);

    const second = await applyAllCandidates(workspaceDir, ranked);
    expect(second.applied).toBe(0);

    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    const sectionCount = memoryText.match(/Promoted From Short-Term Memory/g)?.length ?? 0;
    expect(sectionCount).toBe(1);
  });

  it("rehydrates moved snippets from the live daily note before promotion", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.94, "Moved backups to S3 Glacier."),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(3);
    expect(applied.appliedCandidates[0]?.endLine).toBe(3);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("memory/2026-04-01.md:3-3");
  });

  it("rehydrates daily-ingested heading-prefixed list snippets from the live note", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## 模型切换 (16:23)",
      "- **需求**: 用户想使用小米 Mimo 模型作为默认",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认",
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

  it("rehydrates daily-ingested multi-line list snippets from the full live note range", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## 模型切换 (16:23)",
      "- **需求**: 用户想使用小米 Mimo 模型作为默认",
      "- **偏好**: 保持低成本默认路由",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet:
        "模型切换 (16:23): **需求**: 用户想使用小米 Mimo 模型作为默认; **偏好**: 保持低成本默认路由",
      endLine: 5,
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

  it("rebuilds heading context from the live note during list rehydration", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## 🚀 New model routing (16:23)",
      "- Keep Xiaomi Mimo as the low-cost default.",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Old model routing: Keep Xiaomi Mimo as the low-cost default.",
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "🚀 New model routing (16:23): Keep Xiaomi Mimo as the low-cost default.",
    );
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("🚀 New model routing (16:23)");
    expect(Buffer.from(memoryText, "utf8").toString("utf8")).toBe(memoryText);
    expect(memoryText).not.toContain("Old model routing");
  });

  it("does not rehydrate heading-prefixed list snippets without a live body", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Model routing",
      "",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Model routing: Keep Xiaomi Mimo as the low-cost default.",
    });

    expect(applied.applied).toBe(0);
  });

  it("does not add heading context to ordinary list-item rehydration", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Model routing",
      "- Keep Xiaomi Mimo as the low-cost default.",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Keep Xiaomi Mimo as the low-cost default.",
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toBe("Keep Xiaomi Mimo as the low-cost default.");
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).not.toContain("Model routing: Keep Xiaomi");
  });

  it("rehydrates capped heading-prefixed list snippets from the live note", async (workspaceDir) => {
    const longBody = `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(80)}`.trim();
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Long model routing",
      `- ${longBody}`,
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: `Long model routing: ${longBody}`.slice(0, 280).replace(/\s+/g, " ").trim(),
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(4);
    expect(applied.appliedCandidates[0]?.endLine).toBe(4);
    expect(applied.appliedCandidates[0]?.snippet).toContain("Long model routing: Keep Xiaomi Mimo");
  });

  it("rehydrates capped heading-prefixed list snippets after the heading changes", async (workspaceDir) => {
    const longBody = `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(80)}`.trim();
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## New model routing",
      `- ${longBody}`,
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: `Old model routing: ${longBody}`.slice(0, 280).replace(/\s+/g, " ").trim(),
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toContain("New model routing: Keep Xiaomi Mimo");
    expect(applied.appliedCandidates[0]?.snippet).not.toContain("Old model routing");
  });

  it("keeps renamed heading fallback bound to colon-prefixed list bodies", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Nearby shortcut",
      "- use Mimo",
      "",
      "## New model routing",
      "- **需求**: use Mimo",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Old model routing: **需求**: use Mimo",
      startLine: 7,
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(7);
    expect(applied.appliedCandidates[0]?.endLine).toBe(7);
    expect(applied.appliedCandidates[0]?.snippet).toBe("New model routing: **需求**: use Mimo");
    expect(applied.appliedCandidates[0]?.snippet).not.toContain("Nearby shortcut");
  });

  it("preserves the full range for capped heading-prefixed multi-line list snippets", async (workspaceDir) => {
    const maxDailySnippetChars = 280;
    const firstListItem = `Keep Xiaomi Mimo as the low-cost default ${"route ".repeat(12)}`.trim();
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
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: ingestedSnippet,
      endLine: 5,
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

  it("does not reintroduce generic daily headings during list rehydration", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Model routing",
      "- Keep Xiaomi Mimo as the low-cost default.",
      "",
      "## Morning",
      "- Reviewed travel timing before the workshop.",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Reviewed travel timing before the workshop.",
      startLine: 7,
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "Reviewed travel timing before the workshop.",
    );
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).not.toContain("Morning:");
    expect(memoryText).not.toContain("Model routing: Reviewed travel timing");
  });

  it("does not reintroduce managed dreaming headings during list rehydration", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [
      "# 2026-05-28",
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- Candidate: scratch reflection",
      "<!-- openclaw:dreaming:light:end -->",
      "- Reviewed travel timing before the workshop.",
    ]);
    const applied = await promoteDailyHeadingSnippet(workspaceDir, {
      snippet: "Reviewed travel timing before the workshop.",
      startLine: 7,
    });

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "Reviewed travel timing before the workshop.",
    );
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).not.toContain("Light Sleep:");
  });

  it("keeps rehydrated promotion snippets capped in the recall store", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    const longSnippet = `Moved backup policy ${"x".repeat(maxSnippetChars + 100)}`;
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["intro", longSnippet]);
    await recordMemoryRecalls(workspaceDir, "backup policy", [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.94, longSnippet),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const candidateKey = requireCandidateKey(ranked[0], "long rehydrated");
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet.length).toBeGreaterThan(maxSnippetChars);
    const entries = await readRecallStoreEntries(workspaceDir);
    const storedSnippet = readEntrySnippet(entries[candidateKey] ?? {});
    expect(storedSnippet.length).toBeLessThanOrEqual(maxSnippetChars);
    expect(storedSnippet).toBe(applied.appliedCandidates[0]?.snippet.slice(0, maxSnippetChars));
  });

  it("prefers the nearest matching snippet when the same text appears multiple times", async (workspaceDir) => {
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
    await recordMemoryRecalls(workspaceDir, "backup repeat", [
      memoryRecallResult("memory/2026-04-01.md", 8, 9, 0.9, "Repeat backup note."),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(9);
    expect(applied.appliedCandidates[0]?.endLine).toBe(10);
  });

  it("rehydrates legacy basename-only short-term paths from the memory directory", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Legacy basename path note."]);

    const applied = await applyAllCandidates(workspaceDir, [
      promotionCandidateFixture({
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
      }),
    ]);

    expect(applied.applied).toBe(1);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("source=2026-04-01.md:1-1");
  });

  it("skips promotion when the live daily note no longer contains the snippet", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Different note content now."]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-01.md", 1, 1, 0.94, "Moved backups to S3 Glacier."),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(0);
    await expectEnoent(fs.access(path.join(workspaceDir, "MEMORY.md")));
  });

  it("uses dreaming timezone for recall-day bucketing and promotion headers", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "Cross-midnight router maintenance window.",
    ]);
    await recordMemoryRecalls(
      workspaceDir,
      "router window",
      [
        memoryRecallResult(
          "memory/2026-04-01.md",
          1,
          1,
          0.9,
          "Cross-midnight router maintenance window.",
        ),
      ],
      {
        nowMs: Date.parse("2026-04-01T23:30:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );

    const ranked = await rankAllCandidates(workspaceDir);
    expect(ranked[0]?.recallDays).toEqual(["2026-04-01"]);

    const applied = await applyAllCandidates(workspaceDir, ranked, {
      nowMs: Date.parse("2026-04-02T06:30:00.000Z"),
      timezone: "America/Los_Angeles",
    });

    expect(applied.applied).toBe(1);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("Promoted From Short-Term Memory (2026-04-01)");
  });

  it("audits and repairs invalid store metadata plus stale locks", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "Gateway host uses vector search for router notes.",
    ]);
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
          snippet: "Gateway host uses vector search for router notes.",
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

  it("audits and repairs dangling recall entries and their phase signals", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Live source note."]);
    await fs.mkdir(path.join(workspaceDir, "memory", "2026-04-02.md"));
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        live: recallStoreEntryFixture({ key: "live", path: "memory/2026-04-01.md" }),
        directory: recallStoreEntryFixture({
          key: "directory",
          path: "memory/2026-04-02.md",
        }),
        missing: recallStoreEntryFixture({ key: "missing", path: "memory/2026-04-03.md" }),
      },
    });
    await testing.writeRawPhaseSignalStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        live: { key: "live", lightHits: 1, remHits: 0 },
        directory: { key: "directory", lightHits: 1, remHits: 1 },
        missing: { key: "missing", lightHits: 0, remHits: 1 },
        unrelated: { key: "unrelated", lightHits: 1, remHits: 0 },
      },
    });

    const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditBefore.danglingEntryCount).toBe(2);
    expect(auditBefore.issues).toContainEqual({
      severity: "warn",
      code: "recall-store-dangling",
      message:
        "Short-term recall store contains 2 entries whose source file is missing or not a regular file.",
      fixable: true,
    });

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
    expect(repair.changed).toBe(true);
    expect(repair.rewroteStore).toBe(true);
    expect(repair.removedDanglingEntries).toBe(2);
    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live"]);
    const phaseSignals = await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString());
    expect(Object.keys(phaseSignals.entries)).toEqual(["live", "unrelated"]);

    const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditAfter.danglingEntryCount).toBe(0);
    expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-store-dangling");
  });

  it("fails closed before recall writes when phase-signal state cannot be read", async (workspaceDir) => {
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        missing: recallStoreEntryFixture({
          key: "missing",
          path: "memory/2026-04-03.md",
          snippet: "Missing source recall",
        }),
      },
    });
    const nowIso = "2026-04-05T00:00:00.000Z";
    const recallBefore = await testing.readRecallStore(workspaceDir, nowIso);
    const env = { ...process.env };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      if (options.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
        throw new Error("phase state unavailable");
      }
      return createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
    });
    try {
      await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toThrow(
        "phase state unavailable",
      );
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }
    expect(await testing.readRecallStore(workspaceDir, nowIso)).toEqual(recallBefore);
  });

  it("converges on retry when the recall write fails after phase cleanup", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Live source note."]);
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        live: recallStoreEntryFixture({ key: "live", path: "memory/2026-04-01.md" }),
        missing: recallStoreEntryFixture({ key: "missing", path: "memory/2026-04-03.md" }),
      },
    });
    await testing.writeRawPhaseSignalStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        live: { key: "live", lightHits: 1, remHits: 0 },
        missing: { key: "missing", lightHits: 0, remHits: 1 },
      },
    });

    const env = { ...process.env };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
      if (options.namespace !== SHORT_TERM_RECALL_NAMESPACE) {
        return store;
      }
      return {
        ...store,
        register: async () => {
          throw new Error("recall write unavailable");
        },
      };
    });
    try {
      await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toThrow(
        "recall write unavailable",
      );
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }

    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live", "missing"]);
    expect(
      Object.keys(
        (await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString())).entries,
      ),
    ).toEqual(["live"]);

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: true,
      removedDanglingEntries: 1,
    });
    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live"]);
    expect(
      Object.keys(
        (await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString())).entries,
      ),
    ).toEqual(["live"]);
  });

  it("fails closed without changing recall state when source inspection is denied", async (workspaceDir) => {
    const entry = recallStoreEntryFixture({
      key: "protected",
      path: "memory/2026-04-01.md",
      snippet: "Protected source recall",
    });
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: { protected: entry },
    });
    await testing.writeRawPhaseSignalStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        protected: { key: "protected", lightHits: 1, remHits: 1 },
      },
    });
    const nowIso = "2026-04-05T00:00:00.000Z";
    const recallBefore = await testing.readRecallStore(workspaceDir, nowIso);
    const phaseSignalsBefore = await testing.readPhaseSignalStore(workspaceDir, nowIso);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValue(permissionError);

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toBe(permissionError);
    expect(await testing.readRecallStore(workspaceDir, nowIso)).toEqual(recallBefore);
    expect(await testing.readPhaseSignalStore(workspaceDir, nowIso)).toEqual(phaseSignalsBefore);
  });

  it("audits and repairs oversized recall stores", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Oversized recall source."]);
    const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: Object.fromEntries(
        Array.from({ length: maxEntries + 3 }, (_, index) => [
          `entry-${index}`,
          recallStoreEntryFixture({
            key: `entry-${index}`,
            path: "memory/2026-04-01.md",
            startLine: index + 1,
            endLine: index + 1,
            snippet: `Oversized recall ${index} ${"x".repeat(maxSnippetChars + 100)}`,
            recallCount: 1,
            totalScore: index,
            maxScore: 0.75,
            lastRecalledAt: new Date(Date.parse("2026-04-01T00:00:00.000Z") + index).toISOString(),
            queryHashes: [`q-${index}`],
            recallDays: ["2026-04-01"],
          }),
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
    expect(entries.every((entry) => readEntrySnippet(entry).length <= maxSnippetChars)).toBe(true);
    expect(entries.some((entry) => readEntrySnippet(entry).startsWith("Oversized recall 0 "))).toBe(
      false,
    );
  });

  it("lets new trusted evidence classify legacy entries without provenance", async (workspaceDir) => {
    const key = "memory:memory/2026-04-01.md:1:1";
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-01T10:00:00.000Z",
      entries: {
        [key]: recallStoreEntryFixture({
          key,
          path: "memory/2026-04-01.md",
          snippet: "The owner prefers green tea.",
          recallCount: 1,
          totalScore: 0.8,
          maxScore: 0.8,
          firstRecalledAt: "2026-04-01T10:00:00.000Z",
          lastRecalledAt: "2026-04-01T10:00:00.000Z",
          queryHashes: ["legacy"],
          recallDays: ["2026-04-01"],
        }),
      },
    });
    const legacy = await testing.readRecallStore(workspaceDir, "2026-04-01T10:00:00.000Z");
    expect(legacy.entries[key]?.provenance).toBeUndefined();

    await recordMemoryRecalls(
      workspaceDir,
      "tea preference",
      [
        {
          path: "memory/2026-04-01.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "The owner prefers green tea.",
          source: "memory",
          provenance: {
            originClass: "owner",
            sessionKind: "interactive",
            observedAt: Date.parse("2026-04-02T10:00:00.000Z"),
          },
        },
      ],
      {
        nowMs: Date.parse("2026-04-02T10:00:00.000Z"),
      },
    );

    const updated = await testing.readRecallStore(workspaceDir, "2026-04-02T10:00:00.000Z");
    expect(updated.entries[key]?.provenance).toEqual({
      originClass: "owner",
      sessionKind: "interactive",
      observedAt: Date.parse("2026-04-02T10:00:00.000Z"),
    });
  });

  it("rejects long contaminated legacy recall entries before truncating snippets", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        contaminated: recallStoreEntryFixture({
          key: "contaminated",
          path: "memory/2026-04-01.md",
          snippet: `Candidate: ${"x".repeat(maxSnippetChars + 100)} confidence: 9 evidence: memory/.dreams/session-corpus/2026-04-01.txt status: staged recalls: 1`,
          recallCount: 1,
          totalScore: 1,
          maxScore: 0.75,
          lastRecalledAt: "2026-04-01T00:00:00.000Z",
          queryHashes: ["q"],
          recallDays: ["2026-04-01"],
        }),
      },
    });

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

    expect(repair.changed).toBe(true);
    expect(repair.removedInvalidEntries).toBe(1);
    expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
  });

  it("leaves empty recall stores normalized without rewriting", async (workspaceDir) => {
    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

    expect(repair.changed).toBe(false);
    expect(repair.rewroteStore).toBe(false);
    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("does not rewrite an already normalized healthy recall store", async (workspaceDir) => {
    const snippet = "Gateway host uses vector search for router notes.";
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [snippet]);
    const raw = {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        good: recallStoreEntryFixture({
          key: "good",
          path: "memory/2026-04-01.md",
          endLine: 2,
          snippet,
          conceptTags: deriveConceptTags({
            path: "memory/2026-04-01.md",
            snippet,
          }),
          provenance: {
            originClass: "agent",
            sessionKind: "unknown",
            observedAt: Date.parse("2026-04-04T00:00:00.000Z"),
          },
        }),
      },
    };
    await testing.writeRawRecallStore(workspaceDir, raw);

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

    expect(repair.changed).toBe(false);
    expect(repair.rewroteStore).toBe(false);
    expect(await testing.readRecallStore(workspaceDir, new Date().toISOString())).toEqual(raw);
  });

  it("waits for an active short-term lock before repairing", async (workspaceDir) => {
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

  it("preserves recall updates from sequential and parallel nested workspace writers", async (workspaceDir) => {
    const result = memoryRecallResult(
      "memory/2026-04-03.md",
      1,
      1,
      0.9,
      "Nested workspace writers retain every recall signal.",
    );
    await withMemoryWorkspaceLock(workspaceDir, async () => {
      await recordMemoryRecalls(workspaceDir, "first", [result]);
      await withMemoryWorkspaceLock(workspaceDir, async () => {
        await Promise.all(
          ["second", "third"].map((query) => recordMemoryRecalls(workspaceDir, query, [result])),
        );
      });
    });

    const entries = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recallCount).toBe(3);
  });

  baseIt.each(["root", "nested"] as const)(
    "queues work resumed from a closed %s workspace scope behind the current writer",
    async (closedScope) => {
      await withTempWorkspace(async (workspaceDir) => {
        const resume = createDeferred<void>();
        const attempted = createDeferred<void>();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const order: string[] = [];
        const retainWork = async () => ({
          work: resume.promise.then(async () => {
            attempted.resolve();
            await withMemoryWorkspaceLock(workspaceDir, async () => {
              order.push("resumed");
            });
          }),
        });
        let retained =
          closedScope === "root"
            ? await withMemoryWorkspaceLock(workspaceDir, retainWork)
            : undefined;
        const owner = withMemoryWorkspaceLock(workspaceDir, async () => {
          if (closedScope === "nested") {
            retained = await withMemoryWorkspaceLock(workspaceDir, retainWork);
          }
          entered.resolve();
          await release.promise;
          order.push("released");
        });
        try {
          await entered.promise;
          resume.resolve();
          await attempted.promise;
          expect(order).toEqual([]);
        } finally {
          release.resolve();
          await owner;
          await retained?.work;
        }
        expect(order).toEqual(["released", "resumed"]);
      });
    },
  );

  it("reports stale sqlite locks as repairable audit issues", async (workspaceDir) => {
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

  it("reclaims a stale sqlite lock owned by a Linux zombie", async (workspaceDir) => {
    const ownerPid = 4242;
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${ownerPid}:0`,
      acquiredAt: Date.now() - 120_000,
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath) => {
      if (String(filePath) === `/proc/${ownerPid}/status`) {
        return `Name:\tmemory worker\nState:\tZ (zombie)\nPid:\t${ownerPid}\n`;
      }
      throw new Error(`unexpected read: ${String(filePath)}`);
    });

    const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(audit.issues.map((issue) => issue.code)).toContain("recall-lock-stale");

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: true,
      removedStaleLock: true,
    });
  });

  it("preserves a replacement lock when the expected stale entry is no longer current", async (workspaceDir) => {
    const expected = {
      owner: "4243:stale",
      acquiredAt: Date.now() - 120_000,
    };
    const replacement = {
      owner: `${process.pid}:replacement`,
      acquiredAt: Date.now(),
    };
    const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
    const lockStore = openMemoryCoreStateStore<typeof expected>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    try {
      await lockStore.register(lockKey, replacement);
      await expect(deleteShortTermLockEntryIfCurrent(lockStore, lockKey, expected)).resolves.toBe(
        false,
      );
      await expect(lockStore.lookup(lockKey)).resolves.toEqual(replacement);
    } finally {
      await lockStore.delete(lockKey);
    }
  });

  it("reports concept tag script coverage for multilingual recalls", async (workspaceDir) => {
    await recordMemoryRecalls(workspaceDir, "routeur glacier", [
      memoryRecallResult(
        "memory/2026-04-03.md",
        1,
        2,
        0.93,
        "Configuration du routeur et sauvegarde Glacier.",
      ),
    ]);
    await recordMemoryRecalls(workspaceDir, "router cjk", [
      memoryRecallResult(
        "memory/2026-04-04.md",
        1,
        2,
        0.95,
        "障害対応ルーター設定とバックアップ確認。",
      ),
    ]);

    const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(audit.conceptTaggedEntryCount).toBe(2);
    expect(audit.conceptTagScripts).toEqual({
      latinEntryCount: 1,
      cjkEntryCount: 1,
      mixedEntryCount: 0,
      otherEntryCount: 0,
    });
  });

  describe("MEMORY.md budget compaction (#73691)", () => {
    async function applyBudgetCompactionPromotion(workspaceDir: string) {
      const nowMs = Date.parse("2026-04-29T10:00:00.000Z");
      await recordRotateCredentialsRecall(workspaceDir);
      return await applyAllCandidates(workspaceDir, await rankAllCandidates(workspaceDir), {
        nowMs,
        memoryFileMaxChars: 1_400,
      });
    }

    async function seedBudgetMemory(
      workspaceDir: string,
      firstMarker: string,
      secondMarker: string,
      between: string[] = [],
    ): Promise<string> {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "Rotate the staging Postgres credentials before next deploy.",
      ]);
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const filler = "x".repeat(600);
      await fs.writeFile(
        memoryPath,
        [
          "# Long-Term Memory",
          "",
          "## Promoted From Short-Term Memory (2026-04-10)",
          `<!-- openclaw-memory-promotion:${firstMarker} -->`,
          `- ${filler}`,
          "",
          ...between,
          "## Promoted From Short-Term Memory (2026-04-20)",
          `<!-- openclaw-memory-promotion:${secondMarker} -->`,
          `- ${filler}`,
          "",
        ].join("\n"),
        "utf-8",
      );
      return memoryPath;
    }

    it("preserves mixed marker-backed user text during a real promotion write", async (workspaceDir) => {
      const memoryPath = await seedBudgetMemory(workspaceDir, "legacy-mixed", "legacy-generated", [
        "USER-AUTHORED: recovery key is paper-copy-17",
        "",
      ]);

      const applied = await applyBudgetCompactionPromotion(workspaceDir);

      expect(applied.applied).toBe(1);
      expect(applied.compactedDates).toEqual(["2026-04-20"]);
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).toContain("legacy-mixed");
      expect(memoryText).toContain("USER-AUTHORED: recovery key is paper-copy-17");
      expect(memoryText).not.toContain("legacy-generated");
      expect(memoryText).toContain("Rotate the staging Postgres credentials");
    });

    it("preserves an indented user ATX heading when compaction writes MEMORY.md", async (workspaceDir) => {
      const memoryPath = await seedBudgetMemory(workspaceDir, "legacy-old", "legacy-newer", [
        "   ### Correction (added by me)",
        "The prod DB is db-2.corp.example, NOT db-1.",
        "",
      ]);

      const applied = await applyBudgetCompactionPromotion(workspaceDir);

      expect(applied.applied).toBe(1);
      expect(applied.compactedDates).toContain("2026-04-10");
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).not.toContain("legacy-old");
      expect(memoryText).toContain("   ### Correction (added by me)");
      expect(memoryText).toContain("The prod DB is db-2.corp.example, NOT db-1.");
      expect(memoryText).toContain("Rotate the staging Postgres credentials");
    });

    it("drops the oldest promoted section before write when memoryFileMaxChars would be exceeded", async (workspaceDir) => {
      // Seed an oversized MEMORY.md with two pre-existing promotion sections.
      const memoryPath = await seedBudgetMemory(workspaceDir, "legacy-old", "legacy-newer");

      const applied = await applyBudgetCompactionPromotion(workspaceDir);

      expect(applied.applied).toBe(1);
      expect(applied.compactedSections).toBeGreaterThan(0);
      expect(applied.compactedDates).toContain("2026-04-10");

      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).not.toContain("(2026-04-10)");
      expect(memoryText).not.toContain("legacy-old");
      // Newer pre-existing section + the freshly-written one survive.
      expect(memoryText).toContain("Rotate the staging Postgres credentials");
    });

    it("leaves MEMORY.md untouched when total stays within memoryFileMaxChars", async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "A short snippet that fits comfortably.",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const seeded = "# Long-Term Memory\n\nSome small existing content.\n";
      await fs.writeFile(memoryPath, seeded, "utf-8");
      if (process.platform !== "win32") {
        await fs.chmod(workspaceDir, 0o750);
        await fs.chmod(memoryPath, 0o640);
      }

      await recordMemoryRecalls(
        workspaceDir,
        "tiny note",
        [
          memoryRecallResult(
            "memory/2026-04-29.md",
            3,
            3,
            0.92,
            "A short snippet that fits comfortably.",
          ),
        ],
        { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
      );

      const ranked = await rankAllCandidates(workspaceDir);
      const applied = await applyAllCandidates(workspaceDir, ranked, {
        memoryFileMaxChars: 10_000,
      });

      expect(applied.compactedSections).toBe(0);
      expect(applied.compactedDates).toEqual([]);
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).toContain("Some small existing content.");
      if (process.platform !== "win32") {
        expect((await fs.stat(workspaceDir)).mode & 0o7777).toBe(0o750);
        expect((await fs.stat(memoryPath)).mode & 0o7777).toBe(0o640);
      }
    });
  });

  it("defers append-only promotion when recall state changes during rehydration", async (workspaceDir) => {
    const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
      "Keep the deployment window on Tuesday.",
    ]);
    const recallResult = memoryRecallResult(
      "memory/2026-04-29.md",
      1,
      1,
      0.9,
      "Keep the deployment window on Tuesday.",
    );
    await recordMemoryRecalls(workspaceDir, "deployment window", [recallResult], {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });
    const ranked = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });
    const candidate = expectDefined(ranked[0], "append-only candidate");
    const originalReadFile = fs.readFile.bind(fs);
    let injectedUpdate = false;
    vi.spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (
        !injectedUpdate &&
        typeof args[0] === "string" &&
        path.resolve(args[0]) === path.resolve(notePath)
      ) {
        injectedUpdate = true;
        await recordMemoryRecalls(
          workspaceDir,
          "Tuesday deployment",
          [{ ...recallResult, score: 1 }],
          {
            dayBucket: "2026-04-30",
            nowMs: Date.parse("2026-04-30T10:00:00.000Z"),
          },
        );
      }
      return await originalReadFile(...args);
    }) as typeof fs.readFile);

    const applied = await applyAllCandidates(workspaceDir, ranked, {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });

    expect(applied).toMatchObject({ applied: 0, appended: 0 });
    await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retryable = await rankAllCandidates(workspaceDir, {
      nowMs: Date.parse("2026-04-30T10:00:00.000Z"),
    });
    expect(retryable.map((entry) => entry.key)).toContain(candidate.key);
  });

  describe("MEMORY.md atomic promotion write", () => {
    it.runIf(process.platform !== "win32")(
      "preserves a dangling MEMORY.md symlink and its target directory mode",
      async () => {
        await withTempWorkspace(async (workspaceDir) => {
          await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
            "Keep the shared memory target and directory permissions intact.",
          ]);

          const aliasParent = path.join(fixtureRoot, `alias-${caseId++}`, "nested");
          const workspaceAlias = path.join(aliasParent, "workspace");
          const sharedDir = path.join(fixtureRoot, `${path.basename(workspaceDir)}-shared`);
          const linkedDir = path.join(workspaceDir, "linked");
          const intermediatePath = path.join(sharedDir, "memory-alias.md");
          const targetPath = path.join(sharedDir, `${"long".repeat(55)}\\`);
          const memoryPath = path.join(workspaceDir, "MEMORY.md");
          await fs.mkdir(aliasParent, { recursive: true });
          await fs.mkdir(path.join(sharedDir, "nested"), { recursive: true });
          await fs.chmod(sharedDir, 0o755);
          await fs.symlink(workspaceDir, workspaceAlias);
          await fs.symlink(path.join(sharedDir, "nested"), linkedDir);
          await fs.symlink(path.basename(targetPath), intermediatePath);
          await fs.symlink("invalid-target.md/", memoryPath);

          await recordMemoryRecalls(
            workspaceAlias,
            "shared memory",
            [
              memoryRecallResult(
                "memory/2026-04-29.md",
                1,
                1,
                0.96,
                "Keep the shared memory target and directory permissions intact.",
              ),
            ],
            { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
          );
          const ranked = await rankAllCandidates(workspaceAlias);

          await expect(
            applyShortTermPromotions({
              workspaceDir: workspaceAlias,
              candidates: ranked,
              minScore: 0,
              minRecallCount: 0,
              minUniqueQueries: 0,
            }),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expectEnoent(fs.lstat(path.join(workspaceDir, "invalid-target.md")));
          await fs.unlink(memoryPath);
          await fs.symlink("linked/../memory-alias.md", memoryPath);

          await applyAllCandidates(workspaceAlias, ranked);

          expect((await fs.lstat(memoryPath)).isSymbolicLink()).toBe(true);
          expect((await fs.lstat(intermediatePath)).isSymbolicLink()).toBe(true);
          expect(await fs.readFile(targetPath, "utf-8")).toContain(
            "Keep the shared memory target and directory permissions intact.",
          );
          expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o755);

          const secondSnippet = "Keep writing through a shared read-only directory.";
          await writeDailyMemoryNote(workspaceDir, "2026-04-30", [secondSnippet]);
          await recordMemoryRecalls(
            workspaceAlias,
            "read-only parent",
            [memoryRecallResult("memory/2026-04-30.md", 1, 1, 0.96, secondSnippet)],
            { nowMs: Date.parse("2026-04-30T10:00:00.000Z") },
          );
          const secondRanked = await rankAllCandidates(workspaceAlias);

          await fs.chmod(targetPath, 0o600);
          await fs.chmod(sharedDir, 0o555);
          try {
            const applied = await applyAllCandidates(workspaceAlias, secondRanked, {
              memoryFileMaxChars: 400,
            });
            expect(applied.applied).toBe(1);
            expect(await fs.readFile(targetPath, "utf-8")).toContain(secondSnippet);
            expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o555);
          } finally {
            await fs.chmod(sharedDir, 0o755);
          }
        });
      },
    );

    it("preserves the existing MEMORY.md when the promotion write fails mid-flight", async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "Rotate the staging Postgres credentials before next deploy.",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const sentinel = "FINAL-USER-MEMORY-SENTINEL-do-not-lose";
      const filler = "pad line filler content ".repeat(9_000);
      const seeded = `# Long-Term Memory\n\n${filler}\n- ${sentinel}\n`;
      await fs.writeFile(memoryPath, seeded, "utf-8");

      await recordRotateCredentialsRecall(workspaceDir);

      const ranked = await rankAllCandidates(workspaceDir);

      const truncateAt = 51_200;
      const originalOpen = fs.open.bind(fs);
      const originalWriteFile = fs.writeFile.bind(fs);
      const promotionTempHandles = new WeakSet<object>();
      vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await originalOpen(target, flags, mode);
        if (typeof target === "string" && path.basename(target).startsWith("MEMORY.md.promotion")) {
          promotionTempHandles.add(handle);
        }
        return handle;
      });
      vi.spyOn(fs, "writeFile").mockImplementation((async (
        target: Parameters<typeof fs.writeFile>[0],
        data: Parameters<typeof fs.writeFile>[1],
        options?: Parameters<typeof fs.writeFile>[2],
      ) => {
        const targetPath =
          typeof target === "string" ? target : target instanceof URL ? target.pathname : "";
        if (
          (targetPath && path.basename(targetPath).startsWith("MEMORY.md")) ||
          (typeof target === "object" && target !== null && promotionTempHandles.has(target))
        ) {
          const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
          await originalWriteFile(target, text.slice(0, truncateAt), options);
          throw Object.assign(new Error("EFBIG: file too large, write"), {
            code: "EFBIG",
          });
        }
        return originalWriteFile(target, data, options);
      }) as typeof fs.writeFile);

      await expect(
        applyShortTermPromotions({
          workspaceDir,
          candidates: ranked,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
          memoryFileMaxChars: 5_000_000,
        }),
      ).rejects.toMatchObject({ code: "EFBIG" });

      const after = await fs.readFile(memoryPath, "utf-8");
      expect(after).toBe(seeded);
      await expect(
        rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
        }),
      ).resolves.toHaveLength(1);
      expect(
        (await fs.readdir(workspaceDir)).filter((entry) => entry.startsWith("MEMORY.md.promotion")),
      ).toEqual([]);
    });
  });

  it("shows signalCount instead of just recallCount in promotion annotations", async (workspaceDir) => {
    const nowMs = Date.parse("2026-05-28T10:00:00.000Z");
    const snippet = "Entry with dailyCount signals but zero recallCount.";
    await writeDailyMemoryNote(workspaceDir, "2026-05-28", [snippet]);

    await recordMemoryRecalls(
      workspaceDir,
      "test signal count display",
      [memoryRecallResult("memory/2026-05-28.md", 1, 1, 0.85, snippet)],
      { nowMs },
    );

    const store = await testing.readRecallStore(workspaceDir, new Date(nowMs).toISOString());
    const entryKey = expectDefined(Object.keys(store.entries)[0], "signal-count recall key");
    const entry = expectDefined(store.entries[entryKey], "signal-count recall entry");
    entry.dailyCount = 6;
    entry.recallCount = 0;
    entry.groundedCount = 1;
    await testing.writeRawRecallStore(workspaceDir, store);

    const ranked = await rankAllCandidates(workspaceDir, { nowMs });

    expect(ranked.length).toBe(1);
    const rankedResult = expectDefined(ranked[0], "signal-count ranking result");
    expect(rankedResult.recallCount).toBe(0);
    expect(rankedResult.dailyCount).toBe(6);
    expect(rankedResult.groundedCount).toBe(1);
    expect(rankedResult.signalCount).toBe(7);

    const applied = await applyAllCandidates(workspaceDir, ranked, { nowMs });

    expect(applied.applied).toBe(1);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");

    expect(memoryText).toContain("signals=7");
    expect(memoryText).toContain("recalls=0");
    expect(memoryText).not.toMatch(/recalls=7/);
  });

  describe("UTF-16 snippet bounds", () => {
    it("keeps the dreaming narrative lead well-formed at a surrogate boundary", async (workspaceDir) => {
      const prefix = "x".repeat(199);
      const snippet = `${prefix}🚀Candidate: durable memory`;
      const originalRegExpTest = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")
        ?.value as typeof RegExp.prototype.test;
      const inspectedLeads: string[] = [];

      vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value: string) {
        if (this.source === "\\b(?:Candidate|Reflections?):") {
          inspectedLeads.push(value);
          expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
        }
        return originalRegExpTest.call(this, value);
      });

      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await recordMemoryRecalls(workspaceDir, "utf16 dreaming lead", [
        {
          path: "memory/2026-04-03.md",
          source: "memory",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet,
        },
      ]);

      const ranked = await rankAllCandidates(workspaceDir);

      expect(inspectedLeads.length).toBeGreaterThan(0);
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.snippet).toBe(snippet);
    });

    it("stores a complete-code-point short-term recall snippet", async (workspaceDir) => {
      const prefix = "y".repeat(testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS - 1);
      await recordMemoryRecalls(workspaceDir, "utf16 recall", [
        {
          path: "memory/2026-04-03.md",
          source: "memory",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: `${prefix}🚀tail`,
        },
      ]);

      const entries = Object.values(await readRecallStoreEntries(workspaceDir));
      expect(entries).toHaveLength(1);
      const entry = expectDefined(entries[0], "UTF-16 recall entry");
      expect(readEntrySnippet(entry)).toBe(prefix);
    });

    it("writes a complete-code-point promoted MEMORY.md snippet", async (workspaceDir) => {
      const prefix = "a".repeat(7);
      const snippet = `${prefix}🚀tail`;
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await recordMemoryRecalls(workspaceDir, "utf16 promotion", [
        {
          path: "memory/2026-04-03.md",
          source: "memory",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet,
        },
      ]);
      const ranked = await rankAllCandidates(workspaceDir);

      await applyAllCandidates(workspaceDir, ranked, {
        maxPromotedSnippetTokens: 2,
      });

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain(`- ${prefix}... [`);
      expect(memoryText).not.toContain("🚀");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
