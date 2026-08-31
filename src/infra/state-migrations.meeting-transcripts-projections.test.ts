import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { safeTranscriptPathSegment } from "../transcripts/store-artifacts.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { migrationDb } from "./state-migrations.meeting-transcripts-database.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";
import {
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
} from "./state-migrations.receipts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function createHarness() {
  const stateDir = tempDirs.make("openclaw-transcript-projections-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const root = path.join(stateDir, "transcripts");
  const store = new TranscriptsStore(root, { env });
  const detect = () =>
    detectLegacyMeetingTranscripts({ stateDir, env, doctorOnlyStateMigrations: true });
  const database = () => openOpenClawStateDatabase({ env }).db;
  return {
    stateDir,
    env,
    root,
    store,
    detect,
    database,
    migrate: () => migrateLegacyMeetingTranscripts({ stateDir, env, detected: detect() }),
    snapshot: () => {
      const db = database();
      const queries = migrationDb(db);
      return {
        sessions: executeSqliteQuerySync(
          db,
          queries.selectFrom("meeting_transcript_sessions").selectAll().orderBy("session_id"),
        ).rows,
        utterances: executeSqliteQuerySync(
          db,
          queries
            .selectFrom("meeting_transcript_utterances")
            .selectAll()
            .orderBy("session_id")
            .orderBy("sequence"),
        ).rows,
        summaries: executeSqliteQuerySync(
          db,
          queries.selectFrom("meeting_transcript_summaries").selectAll().orderBy("session_id"),
        ).rows,
        runs: executeSqliteQuerySync(
          db,
          queries.selectFrom("migration_runs").selectAll().orderBy("id"),
        ).rows,
        sources: executeSqliteQuerySync(
          db,
          queries.selectFrom("migration_sources").selectAll().orderBy("source_key"),
        ).rows,
      };
    },
  };
}

async function seedSession(
  harness: ReturnType<typeof createHarness>,
  sessionId: string,
  options: { historicalSlug?: string; export?: boolean } = {},
) {
  const session = {
    sessionId,
    startedAt: "2026-07-01T10:00:00.000Z",
    stoppedAt: "2026-07-01T10:30:00.000Z",
    source: { providerId: "manual-transcript", channelId: "room" },
    title: "Stored notes",
    metadata: { retained: true },
  };
  await harness.store.writeSession(session);
  const utterance = { text: "Preserve this note.", final: true, metadata: { retained: true } };
  await harness.store.appendUtteranceForSession(session, utterance);
  const summary = summarizeTranscripts({ session, utterances: [utterance] });
  await harness.store.writeSummary(summary, session);
  const markdown = "# User-edited notes\n\nKeep  spacing and **formatting**.\n";
  const db = harness.database();
  const queries = migrationDb(db);
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("meeting_transcript_summaries")
      .set({ markdown })
      .where("session_id", "=", sessionId),
  );
  const artifacts = options.export
    ? await harness.store.materializeSessionArtifacts(session, "all")
    : undefined;
  if (options.historicalSlug) {
    // Model the durable projection written before bounded filenames, without
    // constructing an impossible filesystem path or rewriting any note content.
    const selector = `2026-07-01/${options.historicalSlug}`;
    executeSqliteQuerySync(
      db,
      queries
        .updateTable("meeting_transcript_sessions")
        .set({
          selector,
          session_slug: options.historicalSlug,
          export_key: selector.toLowerCase(),
          export_pending_json: '[ "transcript.jsonl" ]',
        })
        .where("session_id", "=", sessionId),
    );
  }
  return { session, summary, markdown, artifacts };
}

describe("meeting transcript Doctor oversized projections", () => {
  it.each([
    {
      label: "safe",
      sessionId: "notes-" + "x".repeat(2200),
      historicalSlug: "notes-" + "x".repeat(2200),
    },
    { label: "encoded", sessionId: "x".repeat(85) + ".", historicalSlug: "%78".repeat(85) + "%2E" },
  ])(
    "detects and repairs $label rows without an export root",
    async ({ sessionId, historicalSlug }) => {
      const harness = createHarness();
      const seeded = await seedSession(harness, sessionId, { historicalSlug });
      await seedSession(harness, "ordinary:notes");
      const before = harness.snapshot();
      await expect(fs.stat(harness.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(detectLegacyMeetingTranscripts({ stateDir: harness.stateDir }).hasLegacy).toBe(false);
      expect(harness.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 0 });
      expect(harness.snapshot()).toEqual(before);

      const result = await harness.migrate();
      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
      closeOpenClawStateDatabaseForTest();
      const slug = safeTranscriptPathSegment(sessionId);
      const expected = structuredClone(before);
      Object.assign(
        expected.sessions.find((row) => row.session_id === sessionId)!,
        {
          selector: `2026-07-01/${slug}`,
          session_slug: slug,
          export_key: `2026-07-01/${slug}`.toLowerCase(),
        },
      );
      expect(harness.snapshot()).toEqual(expected);
      await expect(fs.stat(harness.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(harness.detect().hasLegacy).toBe(false);
      await expect(harness.migrate()).resolves.toEqual({ changes: [], warnings: [] });
      const entry = await harness.store.readSessionEntry(`2026-07-01/${slug}`);
      expect(entry?.session).toEqual(seeded.session);
      expect(await harness.store.readSummary(seeded.session)).toEqual({
        summary: seeded.summary,
        markdown: seeded.markdown,
      });
    },
  );

  it("recognizes bounded exports after repair without archiving or changing export bookkeeping", async () => {
    const harness = createHarness();
    const sessionId = "notes-" + "x".repeat(908);
    const seeded = await seedSession(harness, sessionId, {
      historicalSlug: sessionId,
      export: true,
    });
    const before = harness.snapshot();
    const fileNames = await fs.readdir(seeded.artifacts!.sessionDir);
    const contents = await Promise.all(
      fileNames.map((name) => fs.readFile(path.join(seeded.artifacts!.sessionDir, name), "utf8")),
    );
    const result = await harness.migrate();
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
    const after = harness.snapshot();
    expect(after.utterances).toEqual(before.utterances);
    expect(after.summaries).toEqual(before.summaries);
    expect(after.sessions[0]).toEqual({
      ...before.sessions[0],
      selector: `2026-07-01/${path.basename(seeded.artifacts!.sessionDir)}`,
      session_slug: path.basename(seeded.artifacts!.sessionDir),
      export_key: `2026-07-01/${path.basename(seeded.artifacts!.sessionDir)}`.toLowerCase(),
    });
    expect(
      (await fs.readdir(harness.stateDir)).filter((name) => name.startsWith("transcripts.")),
    ).toEqual([]);
    expect(
      await Promise.all(
        fileNames.map((name) => fs.readFile(path.join(seeded.artifacts!.sessionDir, name), "utf8")),
      ),
    ).toEqual(contents);
    expect(harness.detect().hasLegacy).toBe(false);
    await expect(harness.migrate()).resolves.toEqual({ changes: [], warnings: [] });
    expect(harness.snapshot()).toEqual(after);
  });

  it("rolls back all projection repairs when a bounded selector already has another owner", async () => {
    const harness = createHarness();
    const ids = ["a", "z"].map((prefix) => prefix + "x".repeat(300));
    for (const sessionId of ids) {
      await seedSession(harness, sessionId, { historicalSlug: sessionId });
    }
    await seedSession(harness, safeTranscriptPathSegment(ids[1]!));
    const before = harness.snapshot();
    const result = await harness.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/UNIQUE constraint failed.*selector/i)]);
    closeOpenClawStateDatabaseForTest();
    expect(harness.snapshot()).toEqual(before);
    expect(harness.detect().hasLegacy).toBe(true);
    await expect(fs.stat(harness.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create state when no database or legacy exports exist", async () => {
    const harness = createHarness();
    expect(harness.detect().hasLegacy).toBe(false);
    await expect(harness.migrate()).resolves.toEqual({ changes: [], warnings: [] });
    expect(await fs.readdir(harness.stateDir)).toEqual([]);
  });

  it("keeps committed repair messages and receipts when pending import recovery cannot finish", async () => {
    const harness = createHarness();
    const sessionId = "notes-" + "x".repeat(300);
    await seedSession(harness, sessionId, { historicalSlug: sessionId });
    recordLegacyMigrationRun(harness.database(), {
      runId: "pending-import",
      startedAt: 1,
      finishedAt: null,
      status: "imported",
      reportJson: JSON.stringify({
        format: "meeting-transcripts-files-v1",
        archiveRoot: `${harness.root}.migrated-pending`,
        canonicalRelativeDirs: [],
      }),
    });
    recordLegacyMigrationSource(harness.database(), {
      sourceKey: "pending-source",
      migrationKind: "meeting-transcripts-files-v1",
      sourcePath: path.join(harness.root, "2026-07-01", "legacy"),
      targetTable: "meeting_transcript_sessions",
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 1,
      sourceRecordCount: 1,
      runId: "pending-import",
      status: "imported",
      importedAt: 1,
      reportJson: "{}",
    });
    const before = harness.snapshot();
    const result = await harness.migrate();
    expect(result.changes).toEqual([expect.stringMatching(/1.*oversized/i)]);
    expect(result.warnings).toEqual([expect.stringContaining("neither source tree nor archive")]);
    const after = harness.snapshot();
    expect(after.runs).toEqual(before.runs);
    expect(after.sources).toEqual(before.sources);
    expect(after.sessions[0]?.session_slug).toBe(safeTranscriptPathSegment(sessionId));
    expect(harness.detect()).toMatchObject({ hasLegacy: true, pendingImportCount: 1 });
    expect((await harness.migrate()).changes).toEqual([]);
    expect(harness.snapshot()).toEqual(after);
  });

  it("requires exclusive state ownership before repairing projections", async () => {
    const harness = createHarness();
    const sessionId = "notes-" + "x".repeat(300);
    await seedSession(harness, sessionId, { historicalSlug: sessionId });
    const before = harness.snapshot();
    const lock = await acquireGatewayLock({ allowInTests: true, env: harness.env });
    if (!lock) {
      throw new Error("expected test Gateway lock");
    }
    try {
      const result = await harness.migrate();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("exclusive state ownership is unavailable"),
      ]);
      expect(harness.snapshot()).toEqual(before);
    } finally {
      await lock.release();
    }
    expect((await harness.migrate()).warnings).toEqual([]);
    expect(harness.detect().hasLegacy).toBe(false);
  });
});
