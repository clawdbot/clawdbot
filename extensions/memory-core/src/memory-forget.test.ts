import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { closeMemoryDatabase, openMemoryDatabaseAtPath } from "./memory/manager-db.js";
import { runSessionBackfill } from "./session-backfill.js";
import { readSessionIngestionState, writeSessionIngestionState } from "./session-ingestion.js";
import { buildPromotionRecallAnnotations } from "./short-term-promotion-metadata.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { configureMemoryCoreDreamingStateForTests } from "./test-helpers.js";

describe("memory forget", () => {
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;
  let vectorDatabase: DatabaseSync | undefined;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-forget-")),
    );
    workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
  });

  afterEach(async () => {
    if (vectorDatabase) {
      closeMemoryDatabase(vectorDatabase);
      vectorDatabase = undefined;
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function seedSession(sessionId: string, hookSource?: "gmail" | "webhook"): Promise<void> {
    const sessionKey = `agent:main:${sessionId}`;
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      entry: { sessionId, updatedAt: 1_000 },
    });
    if (hookSource) {
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "UPDATE session_windows SET hook_external_content_source = ? WHERE session_id = ?",
        )
        .run(hookSource, sessionId);
    }
  }

  it.each([
    { label: "session ID", selector: "archived" },
    { label: "session key", selector: "agent:main:archived" },
  ])("purges an archived-only session selected by its $label", async ({ selector }) => {
    await seedSession("archived");
    recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          entryKey: "archived-entry",
          agentId: "main",
          sessionId: "archived",
          sessionKey: "agent:main:archived",
          originClass: "owner",
          observedAt: 1_000,
        },
      ],
    });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Long-Term Memory\n<!-- openclaw-memory-promotion:archived-entry -->\n- Archived secret.\n",
    );
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\nKeep curated profile.\n");
    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(
      path.join(corpusDir, "archived.txt"),
      "[main/sessions/main/archived#L1] User: An archived private fact.\n",
    );
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "archived",
      sessionKey: "agent:main:archived",
      message: {
        role: "assistant",
        timestamp: 2_000,
        content: [
          { type: "toolCall", id: "curated", name: "write", arguments: { path: "USER.md" } },
        ],
      },
    });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:archived",
        expectedSessionId: "archived",
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    expect(
      db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?").get("archived"),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT session_id, session_key FROM session_transcript_archives WHERE session_id = ?",
        )
        .get("archived"),
    ).toEqual({ session_id: "archived", session_key: "agent:main:archived" });

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: [selector],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      sessionIds: ["archived"],
      sessionResolutions: [
        { sessionId: "archived", sessionKey: "agent:main:archived", source: "archived" },
      ],
      entryKeys: ["archived-entry"],
      curatedWrites: [{ relativePath: "USER.md", observedAt: expect.any(Number) }],
      artifacts: { memoryEntries: 1, sessionCorpusLines: 1, originRows: 1 },
    });
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);

    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [selector] });
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).not.toContain(
      "Archived secret",
    );
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toContain(
      "Keep curated profile",
    );
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    expect(listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { sessionId: "archived", reason: "forgotten" },
    ]);
  });

  it("durably tombstones an unresolved explicit session without inventing artifacts", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Long-Term Memory\nKeep this.\n");

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["unknown-session"],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      sessionIds: ["unknown-session"],
      sessionResolutions: [{ sessionId: "unknown-session", source: "unresolved" }],
    });
    expect(Object.values(preview.artifacts).every((count) => count === 0)).toBe(true);
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["unknown-session"],
    });
    expect(report).toEqual({ ...preview, dryRun: false });
    const tombstones = listMemorySessionTombstones({ agentId: "main" });
    expect(tombstones).toMatchObject([{ sessionId: "unknown-session", reason: "forgotten" }]);
    expect(
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["unknown-session"] }),
    ).toEqual(report);
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual(tombstones);
  });

  it("removes staged backfill entries when their source session is forgotten", async () => {
    await seedSession("backfilled");
    const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
    const privateFact = "The project launch code is amber-indigo.";
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "backfilled",
      sessionKey: "agent:main:backfilled",
      message: {
        role: "user",
        content: privateFact,
        timestamp: nowMs,
        __openclaw: { senderIsOwner: true },
      },
    });
    const applied = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs,
      timezone: "UTC",
    });
    expect(applied.stagedEntries).toBe(1);
    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["backfilled"],
    });
    const remaining = await readShortTermRecallEntries({ workspaceDir, nowMs });
    expect(report.artifacts.shortTermEntries).toBe(1);
    expect(remaining.map((entry) => entry.snippet)).not.toContain(privateFact);
  });

  it.each(["prefix-survivor", "prefix.jsonl.other", "PREFIX"])(
    "does not purge session %s when an unresolved explicit selector is prefix",
    async (survivorId) => {
      await seedSession(survivorId);
      const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      await fs.mkdir(corpusDir, { recursive: true });
      const corpusPath = path.join(corpusDir, "2026-08-26.txt");
      const content = `[main/sessions/main/${survivorId}#L1] User: Preserve this unrelated fact.\n`;
      await fs.writeFile(corpusPath, content);
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(
        `INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES ('survivor-chunk', ?, 'sessions', 1, 1,
         'survivor-hash', 'test', 'Preserve this unrelated fact.', '[1,0]', 1)`,
      ).run(`sessions/main/${survivorId}.jsonl`);
      db.prepare(
        `INSERT INTO memory_index_chunk_provenance
        (chunk_id, origin_class, session_kind, observed_at)
       VALUES ('survivor-chunk', 'owner', 'interactive', 1)`,
      ).run();
      const report = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["prefix"],
      });
      const remainingContent = await fs.readFile(corpusPath, "utf8").catch(() => "missing");
      const remainingChunks = db.prepare("SELECT id FROM memory_index_chunks").all();
      expect(report.sessionResolutions).toEqual([{ sessionId: "prefix", source: "unresolved" }]);
      expect(remainingContent).toBe(content);
      expect(remainingChunks).toEqual([{ id: "survivor-chunk" }]);
    },
  );

  it("does not infer hook or participant facts for an archived-only session", async () => {
    await seedSession("archived", "gmail");
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO session_participants
         (session_key, actor_type, actor_id, first_prompted_at, last_prompted_at)
       VALUES (?, 'user', 'participant', 1, 1)`,
    ).run("agent:main:archived");
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "archived",
      sessionKey: "agent:main:archived",
      message: { role: "user", content: "Archive this session." },
    });
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:archived",
      expectedSessionId: "archived",
      archiveTranscript: true,
    });

    for (const selectors of [{ hookSources: ["gmail"] }, { participants: ["participant"] }]) {
      const report = await forgetMemoryEntries({ cfg, agentId: "main", ...selectors });
      expect(report.sessionIds).toEqual([]);
      expect(report.sessionResolutions).toEqual([]);
    }
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
  });

  it.each(["merged", "superseded"] as const)(
    "preserves another workspace agent's deletion lineage when an entry is %s",
    async (action) => {
      cfg = {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [
            { id: "alpha", default: true, workspace: workspaceDir },
            { id: "gamma", workspace: workspaceDir },
            { id: "vacant", workspace: workspaceDir },
          ],
        },
      } as OpenClawConfig;
      await upsertSessionEntry({
        agentId: "gamma",
        sessionKey: "agent:gamma:private-session",
        entry: { sessionId: "private-session", updatedAt: 1_000 },
      });
      const priorEntry = "- The launch code is violet.";
      const snippet =
        action === "merged" ? "The launch code is violet." : "The launch code is cobalt.";
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(
        memoryPath,
        [
          "# Long-Term Memory",
          ...(action === "superseded" ? ["<!-- openclaw-memory-lineage:launch-code -->"] : []),
          "<!-- openclaw-memory-promotion:retired-entry -->",
          priorEntry,
          "",
        ].join("\n"),
      );
      const notePath = path.join(workspaceDir, "memory", "2026-08-26.md");
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, `${snippet}\n`);
      recordMemoryEntryOrigins({
        agentId: "gamma",
        origins: [
          {
            entryKey: "retired-entry",
            agentId: "gamma",
            sessionId: "private-session",
            sessionKey: "agent:gamma:private-session",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
      const vacantDb = openOpenClawAgentDatabase({ agentId: "vacant" }).db;
      vacantDb.exec("DROP TABLE IF EXISTS memory_entry_origins");
      const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "launch code",
        signalType: "daily",
        nowMs,
        results: [
          {
            path: "memory/2026-08-26.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
            provenance: {
              originClass: "owner",
              sessionKind: "interactive",
              observedAt: nowMs,
              ...(action === "superseded" ? { supersedesKey: "launch-code" } : {}),
            },
            sessionOrigin: {
              agentId: "alpha",
              sessionId: "alpha-session",
              sessionKey: "agent:alpha:alpha-session",
            },
          },
        ],
      });
      const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs,
        ...thresholds,
      });
      const promoted = candidates[0];
      expect(promoted).toBeDefined();
      const resultEntry = `- ${promoted!.snippet} Source: ${promoted!.path}#L1-L1 ${buildPromotionRecallAnnotations(promoted!)}`;
      const output = JSON.stringify({
        memory: `# Long-Term Memory\n${resultEntry}\n`,
        operations: [
          { candidateKey: promoted!.key, action, resultEntry, priorEntries: [priorEntry] },
        ],
      });
      const subagent = {
        run: vi.fn(async () => ({ runId: "shared-consolidation" })),
        waitForRun: vi.fn(async () => ({ status: "ok" })),
        getSessionMessages: vi.fn(async () => ({
          messages: [{ role: "assistant", content: output }],
        })),
        deleteSession: vi.fn(async () => undefined),
      };

      const applied = await applyShortTermPromotions({
        agentId: "alpha",
        workspaceAgentIds: ["vacant", "gamma", "alpha", "gamma"],
        workspaceDir,
        candidates,
        consolidation: { subagent, logger: { info: vi.fn(), warn: vi.fn() } },
        maxPriorEntryLossFraction: 1,
        nowMs,
        ...thresholds,
      });

      expect(applied.applied).toBe(1);
      expect(listMemoryEntryOrigins({ agentId: "gamma" })).toMatchObject([
        { entryKey: promoted!.key, sessionId: "private-session" },
      ]);
      expect(
        vacantDb
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_entry_origins'")
          .get(),
      ).toBeUndefined();

      const report = await forgetMemoryEntries({
        cfg,
        agentId: "gamma",
        sessionIds: ["private-session"],
      });
      expect(report).toMatchObject({
        entryKeys: [promoted!.key],
        artifacts: { memoryEntries: 1, originRows: 1 },
      });
      expect(await fs.readFile(memoryPath, "utf8")).not.toContain(snippet);
      expect(listMemoryEntryOrigins({ agentId: "gamma" })).toEqual([]);
    },
  );

  it("removes a marker-addressable plain-append promotion after budget compaction", async () => {
    await seedSession("target");
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const snippet = "The undisclosed launch code is cobalt.";
    const sourcePath = "memory/2026-08-25.md";
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, sourcePath), `${snippet}\n`);
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# Long-Term Memory",
        "Curated operator fact.",
        "",
        "## Promoted From Short-Term Memory (2026-08-24)",
        "<!-- openclaw-memory-promotion:older-entry -->",
        `- ${"x".repeat(500)}`,
        "",
      ].join("\n"),
    );
    await recordShortTermRecalls({
      workspaceDir,
      query: "launch code",
      signalType: "daily",
      nowMs,
      results: [
        {
          path: sourcePath,
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet,
          source: "memory",
          provenance: { originClass: "owner", sessionKind: "interactive", observedAt: nowMs },
          sessionOrigin: {
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
          },
        },
      ],
    });
    const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      nowMs,
      ...thresholds,
    });
    const candidateKey = candidates[0]?.key;
    expect(candidateKey).toMatch(/^memory:claim:/);

    const promoted = await applyShortTermPromotions({
      agentId: "main",
      workspaceDir,
      candidates,
      nowMs,
      memoryFileMaxChars: 450,
      ...thresholds,
    });
    expect(promoted.appended).toBe(1);
    expect(promoted.compactedDates).toEqual(["2026-08-24"]);
    const promotedMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(promotedMemory).toContain(`<!-- openclaw-memory-promotion:${candidateKey} -->`);
    expect(promotedMemory).toContain(snippet);

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
    });

    expect(report).toMatchObject({
      entryKeys: [candidateKey],
      artifacts: { memoryFiles: 1, memoryEntries: 1, shortTermEntries: 1, originRows: 1 },
    });
    const survivingMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(survivingMemory).toContain("Curated operator fact.");
    expect(survivingMemory).not.toContain(snippet);
    expect(survivingMemory).not.toContain(candidateKey);
  });

  it("durably purges every derived owner, archived narrative, and verbatim dream quote", async () => {
    await seedSession("survivor");
    await seedSession("target", "gmail");
    recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          entryKey: "mixed-entry",
          agentId: "main",
          sessionId: "target",
          sessionKey: "agent:main:target",
          originClass: "owner",
          observedAt: 1_000,
        },
        {
          entryKey: "mixed-entry",
          agentId: "main",
          sessionId: "survivor",
          sessionKey: "agent:main:survivor",
          originClass: "owner",
          observedAt: 1_000,
        },
        {
          entryKey: "clean-entry",
          agentId: "main",
          sessionId: "survivor",
          sessionKey: "agent:main:survivor",
          originClass: "owner",
          observedAt: 1_000,
        },
      ],
    });
    const memoryContent = [
      "# Long-Term Memory",
      "Curated operator fact.",
      "<!-- openclaw-memory-lineage:old-lineage -->",
      "<!-- openclaw-memory-promotion:mixed-entry -->",
      "- Erase the mixed secret.",
      "<!-- openclaw-memory-promotion:clean-entry -->",
      "- Keep the clean fact.",
      "<!-- openclaw-memory-promotion:legacy-entry -->",
      "- Preserve an untargetable legacy fact.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\nCurated private profile.\n");
    const sourceSnippet = "User: Please remember violet-mongoose-42.";
    const assistantSnippet = "Assistant: The launch code is violet-mongoose-42.";
    const lightDiaryPath = path.join(workspaceDir, "memory", "dreaming", "light", "2026-08-26.md");
    const rootDiaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.mkdir(path.dirname(lightDiaryPath), { recursive: true });
    await fs.writeFile(
      lightDiaryPath,
      `# Light Dream\n- Candidate: ${sourceSnippet}\n- Candidate: Keep an unrelated memory.\n`,
    );
    await fs.writeFile(rootDiaryPath, `# Dream Diary\n- Candidate: ${assistantSnippet}\n`);
    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    const mixedCorpusPath = path.join(corpusDir, "2026-08-25.txt");
    const removedCorpusPath = path.join(corpusDir, "2026-08-26.txt");
    await fs.writeFile(
      mixedCorpusPath,
      `[main/sessions/main/target#L1] ${sourceSnippet}\n[main/sessions/main/survivor#L1] keep\n`,
    );
    await fs.writeFile(removedCorpusPath, `[main/sessions/main/target#L2] ${assistantSnippet}\n`);
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "mixed-entry",
          value: { key: "mixed-entry", path: "memory/source.md", snippet: "erase" },
        },
        {
          key: "clean-entry",
          value: { key: "clean-entry", path: "memory/source.md", snippet: "keep" },
        },
      ],
    });
    await writeSessionIngestionState(workspaceDir, {
      version: 3,
      files: {
        "main:sessions/main/target": {
          mtimeMs: 1,
          size: 1,
          contentHash: "hash",
          lineCount: 1,
          lastContentLine: 1,
        },
      },
      seenMessages: {
        "main:sessions/main/target": ["target-hash"],
        "main:sessions/main/survivor": ["survivor-hash"],
      },
    });
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "backup",
          value: {
            createdAt: "2026-08-25T00:00:00.000Z",
            content: `${memoryContent}- Candidate: ${sourceSnippet}\n`,
            contentHash: createHash("sha256")
              .update(`${memoryContent}- Candidate: ${sourceSnippet}\n`)
              .digest("hex"),
          },
        },
      ],
    });

    const agentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
    const db = openMemoryDatabaseAtPath(agentDatabase.path, true, "main");
    vectorDatabase = db;
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(
        text, id UNINDEXED, path UNINDEXED, source UNINDEXED,
        model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED
      );
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY, embedding FLOAT[2]
      );
    `);
    const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "target.jsonl");
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, "source transcript survives deletion\n");
    const narrativeSessionId = "3cb3f634-6821-4123-8123-abcdef123456";
    const narrativeArchiveName = `${narrativeSessionId}.jsonl.deleted.2026-08-26T10-00-00.000Z.zst`;
    const narrativeArchivePath = path.join(path.dirname(transcriptPath), narrativeArchiveName);
    const narrativeTranscript = [
      {
        type: "message",
        message: { role: "user", content: `Write a dream diary entry: ${sourceSnippet}` },
      },
      {
        type: "session",
        sessionKey: "agent:main:dreaming-narrative-memory-core-v2-light-orphan",
      },
    ];
    await fs.writeFile(
      narrativeArchivePath,
      zstdCompressSync(
        `${narrativeTranscript.map((record) => JSON.stringify(record)).join("\n")}\n`,
      ),
    );
    expect(
      db
        .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
        .get(narrativeSessionId),
    ).toBeUndefined();
    const indexedFiles = [
      { path: "MEMORY.md", source: "memory", originClass: "owner" },
      {
        path: "memory/.dreams/session-corpus/2026-08-26.txt",
        source: "memory",
        originClass: "owner",
      },
      {
        path: "sessions/main/target.jsonl.reset.2026-08-25T10-00-00.000Z.zst",
        source: "sessions",
        originClass: "owner",
      },
      {
        path: `sessions/main/${narrativeArchiveName}`,
        source: "sessions",
        originClass: "owner",
        sessionKind: "unknown",
        text: "violet",
      },
      {
        path: "sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst",
        source: "sessions",
        originClass: "owner",
      },
    ];
    for (const [index, file] of indexedFiles.entries()) {
      const chunkId = `chunk-${index}`;
      const hash = `hash-${index}`;
      const text = file.text ?? "erase";
      db.prepare(
        `INSERT INTO memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        ) VALUES (?, ?, ?, 1, 1, ?, 'test', ?, '[1,0]', 1)`,
      ).run(chunkId, file.path, file.source, hash, text);
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 1, 1)",
      ).run(file.path, file.source, hash);
      db.prepare(
        `INSERT INTO memory_index_chunks_fts
          (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, ?, 'test', 1, 1)`,
      ).run(text, chunkId, file.path, file.source);
      db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
        chunkId,
        new Float32Array([1, 0]),
      );
      db.prepare(
        `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES ('test', 'test', 'test', ?, '[1,0]', 2, 1)`,
      ).run(hash);
      db.prepare(
        `INSERT INTO memory_index_chunk_provenance
          (chunk_id, origin_class, session_kind, observed_at)
         VALUES (?, ?, ?, 1)`,
      ).run(chunkId, file.originClass, file.sessionKind ?? "interactive");
    }
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
    const revisionBefore = (
      db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
        revision: number;
      }
    ).revision;

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      hookSources: ["gmail"],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      sessionIds: ["target"],
      entryKeys: ["mixed-entry"],
      mixedLineageEntryKeys: ["mixed-entry"],
      untargetableEntryKeys: ["legacy-entry"],
      artifacts: {
        memoryFiles: 3,
        memoryEntries: 1,
        memoryLines: 2,
        sessionCorpusFiles: 2,
        sessionCorpusLines: 2,
        indexChunks: 4,
        indexSources: 3,
        ftsRows: 4,
        vectorRows: 4,
        embeddingCacheRows: 4,
        shortTermEntries: 1,
        seenHashScopes: 1,
        backups: 1,
        originRows: 2,
      },
    });
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_session_tombstones"),
    ).toBeUndefined();
    expect(
      (
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision,
    ).toBe(revisionBefore);

    const report = await forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] });
    expect(report).toEqual({ ...preview, dryRun: false });
    const survivingMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(survivingMemory).toContain("Curated operator fact.");
    expect(survivingMemory).toContain("Keep the clean fact.");
    expect(survivingMemory).toContain("Preserve an untargetable legacy fact.");
    expect(survivingMemory).not.toContain("mixed secret");
    expect(survivingMemory).not.toContain("old-lineage");
    expect(await fs.readFile(lightDiaryPath, "utf8")).toBe(
      "# Light Dream\n- Candidate: Keep an unrelated memory.\n",
    );
    expect(await fs.readFile(rootDiaryPath, "utf8")).toBe("# Dream Diary\n");
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toContain("Curated");
    expect(await fs.readFile(mixedCorpusPath, "utf8")).toBe(
      "[main/sessions/main/survivor#L1] keep\n",
    );
    await expect(fs.stat(removedCorpusPath)).rejects.toMatchObject({ code: "ENOENT" });
    for (const table of [
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_chunks_vec",
      "memory_index_chunk_provenance",
      "memory_embedding_cache",
    ]) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      ).toBe(1);
    }
    expect(
      (db.prepare("SELECT path FROM memory_index_sources").all() as Array<{ path: string }>).map(
        (row) => row.path,
      ),
    ).toEqual(["MEMORY.md", "sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst"]);
    expect(
      db
        .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
        .all("violet"),
    ).toEqual([]);
    expect(await fs.readFile(transcriptPath, "utf8")).toBe("source transcript survives deletion\n");
    expect(
      (
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision,
    ).toBeGreaterThan(revisionBefore);
    expect(
      (
        await readMemoryCoreWorkspaceEntries({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir,
        })
      ).map((entry) => entry.key),
    ).toEqual(["clean-entry"]);
    expect((await readSessionIngestionState(workspaceDir)).seenMessages).toEqual({
      "main:sessions/main/survivor": ["survivor-hash"],
    });
    const backups = await readMemoryCoreWorkspaceEntries<{
      content: string;
      contentHash: string;
    }>({ namespace: DREAMING_MEMORY_BACKUP_NAMESPACE, workspaceDir });
    expect(backups[0]?.value.content).not.toContain("mixed secret");
    expect(backups[0]?.value.content).not.toContain(sourceSnippet);
    expect(backups[0]?.value.contentHash).toBe(
      createHash("sha256").update(backups[0]!.value.content).digest("hex"),
    );
    expect(listMemoryEntryOrigins({ agentId: "main" }).map((origin) => origin.entryKey)).toEqual([
      "clean-entry",
    ]);
    const tombstones = listMemorySessionTombstones({ agentId: "main" });
    expect(tombstones).toEqual([
      {
        agentId: "main",
        sessionId: "target",
        reason: "forgotten",
        createdAt: expect.any(Number),
      },
    ]);

    const repeated = await forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] });
    expect(repeated.sessionIds).toEqual(["target"]);
    expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual(tombstones);
  });

  it("keeps missing provenance untargetable without creating its table during dry-run", async () => {
    await seedSession("target");
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec("DROP TABLE IF EXISTS memory_entry_origins");
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
    const memoryContent =
      "# Long-Term Memory\n<!-- openclaw-memory-promotion:legacy-entry -->\n- Keep old memory.\n";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
    const revision = (
      db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
        revision: number;
      }
    ).revision;

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
      dryRun: true,
    });

    expect(report.entryKeys).toEqual([]);
    expect(report.untargetableEntryKeys).toEqual(["legacy-entry"]);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_entry_origins"),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_session_tombstones"),
    ).toBeUndefined();
    expect(
      (
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision,
    ).toBe(revision);

    const deleted = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
    expect(deleted.artifacts.memoryFiles).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
    expect(listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { agentId: "main", sessionId: "target", reason: "forgotten" },
    ]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_entry_origins"),
    ).toBeUndefined();
  });
});
