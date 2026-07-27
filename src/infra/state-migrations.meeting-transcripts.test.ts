import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { restoreCanonicalMeetingTranscriptExports } from "./state-migrations.meeting-transcripts-files.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function seedLegacySession(params: {
  stateDir: string;
  sessionId: string;
  date?: string;
  invalidTranscript?: boolean;
  utteranceCount?: number;
  emptyMarkdown?: boolean;
  omitSummaryJson?: boolean;
}): Promise<string> {
  const date = params.date ?? "2026-07-01";
  const sessionDir = path.join(params.stateDir, "transcripts", date, params.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const session = {
    sessionId: params.sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript", meetingUrl: "https://meet.example.invalid/room" },
    startedAt: `${date}T10:00:00.000Z`,
    stoppedAt: `${date}T10:30:00.000Z`,
  };
  await fs.writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    params.invalidTranscript
      ? "{invalid\n"
      : Array.from({ length: params.utteranceCount ?? 2 }, (_, index) =>
          JSON.stringify({
            id: `u-${index + 1}`,
            sessionId: params.sessionId,
            speaker: { label: index % 2 === 0 ? "Alex" : "Sam" },
            text: index === 0 ? "First line" : index === 1 ? "Second line" : `Line ${index + 1}`,
            final: true,
          }),
        ).join("\n") + "\n",
  );
  const summary = {
    sessionId: params.sessionId,
    title: "Design review",
    generatedAt: `${date}T10:31:00.000Z`,
    overview: "First line. Second line.",
    transcript: ["Alex: First line", "Sam: Second line"],
    decisions: [],
    actionItems: [],
    risks: [],
    utteranceCount: params.utteranceCount ?? 2,
  };
  if (!params.omitSummaryJson) {
    await fs.writeFile(
      path.join(sessionDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  await fs.writeFile(
    path.join(sessionDir, "summary.md"),
    params.emptyMarkdown ? "" : "# Design review\n\nFirst line.\n",
  );
  return sessionDir;
}

function databaseEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

describe("meeting transcript Doctor migration", () => {
  it("is doctor-only", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({ stateDir, sessionId: "design-review" });

    expect(detectLegacyMeetingTranscripts({ stateDir })).toMatchObject({ hasLegacy: false });
    expect(
      detectLegacyMeetingTranscripts({ stateDir, doctorOnlyStateMigrations: true }),
    ).toMatchObject({ hasLegacy: true });
  });

  it("surfaces filesystem errors during detection", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await fs.writeFile(path.join(stateDir, "transcripts"), "not a directory");

    expect(() =>
      detectLegacyMeetingTranscripts({
        stateDir,
        doctorOnlyStateMigrations: true,
      }),
    ).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked transcript root before migration",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
      const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
      await fs.symlink(externalRoot, path.join(stateDir, "transcripts"), "dir");

      expect(() =>
        detectLegacyMeetingTranscripts({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
      ).toThrow("regular directory");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked date and session directories during detection",
    async () => {
      for (const target of ["date", "session"] as const) {
        const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
        const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
        const transcriptsDir = path.join(stateDir, "transcripts");
        await fs.mkdir(transcriptsDir, { recursive: true });
        if (target === "date") {
          await fs.symlink(externalRoot, path.join(transcriptsDir, "2026-07-01"), "dir");
        } else {
          const dateDir = path.join(transcriptsDir, "2026-07-01");
          await fs.mkdir(dateDir);
          await fs.symlink(externalRoot, path.join(dateDir, "linked-session"), "dir");
        }

        expect(() =>
          detectLegacyMeetingTranscripts({
            stateDir,
            doctorOnlyStateMigrations: true,
          }),
        ).toThrow("cannot be a symlink");
      }
    },
  );

  it("imports, verifies, receipts, archives, and reopens SQLite-only", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const sourceDir = await seedLegacySession({ stateDir, sessionId: "design-review" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("2 utterances");
    await expect(fs.stat(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });
    const archives = (await fs.readdir(stateDir)).filter((entry) =>
      entry.startsWith("transcripts.migrated-2026-07-02T00-00-00-000Z"),
    );
    expect(archives).toHaveLength(1);

    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    expect(
      database
        .prepare(
          "SELECT status, removed_source, source_record_count FROM migration_sources WHERE migration_kind = ?",
        )
        .get("meeting-transcripts-files-v1"),
    ).toEqual({ status: "archived", removed_source: 1, source_record_count: 2 });

    closeOpenClawStateDatabaseForTest();
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = await store.readSession("design-review");
    expect(session).toMatchObject({ title: "Design review" });
    await expect(store.readUtterancesForSession(session!)).resolves.toEqual([
      expect.objectContaining({ id: "u-1", text: "First line" }),
      expect.objectContaining({ id: "u-2", text: "Second line" }),
    ]);
    await expect(store.readSummary(session!)).resolves.toMatchObject({
      markdown: "# Design review\n\nFirst line.\n",
    });
  });

  it("imports shipped dot-only session layouts into reserved SQLite selectors", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    for (const sessionId of [".", "..", "session"]) {
      await seedLegacySession({ stateDir, sessionId });
    }
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const expectedSlugs = new Map([
      [".", "%2E"],
      ["..", "%2E%2E"],
      ["session", "session"],
    ]);
    for (const [sessionId, expectedSlug] of expectedSlugs) {
      const session = await store.readSession(sessionId);
      expect(session?.sessionId).toBe(sessionId);
      expect(store.sessionDir(session!)).toBe(
        path.join(stateDir, "transcripts", "2026-07-01", expectedSlug),
      );
      const artifacts = await store.materializeSessionArtifacts(session!, "transcript");
      const lines = (await fs.readFile(artifacts.transcriptPath, "utf8")).trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).text)).toEqual(["First line", "Second line"]);
    }
  });

  it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
    "imports case-distinct sessions from a case-sensitive legacy tree",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
      await seedLegacySession({ stateDir, sessionId: "Capital" });
      await seedLegacySession({ stateDir, sessionId: "capital" });
      const detected = detectLegacyMeetingTranscripts({
        stateDir,
        doctorOnlyStateMigrations: true,
      });

      const result = await migrateLegacyMeetingTranscripts({
        detected,
        env: databaseEnv(stateDir),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: databaseEnv(stateDir),
      });
      await expect(store.readSession("2026-07-01/Capital")).resolves.toMatchObject({
        sessionId: "Capital",
      });
      await expect(store.readSession("2026-07-01/capital")).resolves.toMatchObject({
        sessionId: "capital",
      });
      const upper = (await store.readSession("2026-07-01/Capital"))!;
      const lower = (await store.readSession("2026-07-01/capital"))!;
      const upperArtifacts = await store.materializeSessionArtifacts(upper, "metadata");
      await store.materializeSessionArtifacts(lower, "metadata");
      await fs.rename(
        upperArtifacts.sessionDir,
        path.join(stateDir, "transcripts", "2026-07-01", "CAPITAL"),
      );
      expect(
        detectLegacyMeetingTranscripts({
          stateDir,
          env: databaseEnv(stateDir),
          doctorOnlyStateMigrations: true,
        }),
      ).toMatchObject({ hasLegacy: false });
    },
  );

  it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
    "does not assign a case-distinct legacy directory to an existing SQLite session",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: databaseEnv(stateDir),
      });
      await store.writeSession({
        sessionId: "Capital",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-07-01T09:00:00.000Z",
      });
      await seedLegacySession({ stateDir, sessionId: "capital" });
      const detected = detectLegacyMeetingTranscripts({
        stateDir,
        env: databaseEnv(stateDir),
        doctorOnlyStateMigrations: true,
      });

      const result = await migrateLegacyMeetingTranscripts({
        detected,
        env: databaseEnv(stateDir),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      await expect(store.readSession("2026-07-01/Capital")).resolves.toMatchObject({
        sessionId: "Capital",
      });
      await expect(store.readSession("2026-07-01/capital")).resolves.toMatchObject({
        sessionId: "capital",
      });
    },
  );

  it("preflights the whole tree before importing anything", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const validDir = await seedLegacySession({ stateDir, sessionId: "valid" });
    const invalidDir = await seedLegacySession({
      stateDir,
      sessionId: "invalid",
      invalidTranscript: true,
    });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed migrating meeting transcripts");
    await expect(fs.stat(validDir)).resolves.toBeDefined();
    await expect(fs.stat(invalidDir)).resolves.toBeDefined();
    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM meeting_transcript_sessions").get(),
    ).toEqual({ count: 0 });
  });

  it("archives metadata-less interrupted session directories without blocking import", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({ stateDir, sessionId: "complete-session" });
    const incompleteRelativeDir = path.join("2026-07-01", "incomplete-session");
    await fs.mkdir(path.join(stateDir, "transcripts", incompleteRelativeDir));
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.stat(
        path.join(stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z", incompleteRelativeDir),
      ),
    ).resolves.toBeDefined();
  });

  it("detects and recovers a partial-only legacy transcript tree", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const partialDir = path.join(stateDir, "transcripts", "2026-07-01", "partial-only");
    await fs.mkdir(partialDir, { recursive: true });
    await fs.writeFile(path.join(partialDir, "transcript.jsonl"), '{"text":"partial"}\n');
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("incomplete meeting transcript directory");
    await expect(fs.stat(path.join(partialDir, "transcript.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(
        path.join(
          stateDir,
          "transcripts.partials-recovered-2026-07-02T00-00-00-000Z",
          "2026-07-01",
          "partial-only",
          "transcript.jsonl",
        ),
      ),
    ).resolves.toBeDefined();
  });

  it.runIf(process.platform !== "win32")(
    "preflights every partial artifact before moving any source",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
      const externalDir = tempDirs.make("openclaw-meeting-transcripts-external-");
      const partialDir = path.join(stateDir, "transcripts", "2026-07-01", "partial-invalid");
      await fs.mkdir(partialDir, { recursive: true });
      await fs.writeFile(path.join(partialDir, "summary.md"), "keep me\n");
      await fs.writeFile(path.join(externalDir, "transcript.jsonl"), '{"text":"outside"}\n');
      await fs.symlink(
        path.join(externalDir, "transcript.jsonl"),
        path.join(partialDir, "transcript.jsonl"),
      );
      expect(() =>
        detectLegacyMeetingTranscripts({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
      ).toThrow("regular file");
      await expect(fs.readFile(path.join(partialDir, "summary.md"), "utf8")).resolves.toBe(
        "keep me\n",
      );
    },
  );

  it("rolls back when a session appears between verification and archive", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const sourceDir = await seedLegacySession({ stateDir, sessionId: "verified" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      testHooks: {
        afterImport: () => {
          const lateDir = path.join(stateDir, "transcripts", "2026-07-03", "late-session");
          fsSync.mkdirSync(lateDir, { recursive: true });
          fsSync.writeFileSync(
            path.join(lateDir, "metadata.json"),
            JSON.stringify({
              sessionId: "late-session",
              source: { providerId: "manual-transcript" },
              startedAt: "2026-07-03T10:00:00.000Z",
            }),
          );
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("session tree changed before archive");
    await expect(fs.stat(sourceDir)).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(stateDir, "transcripts", "2026-07-03", "late-session")),
    ).resolves.toBeDefined();
    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM meeting_transcript_sessions").get(),
    ).toEqual({ count: 0 });
  });

  it("does not mistake a colliding archive destination for a completed move", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const sourceDir = await seedLegacySession({ stateDir, sessionId: "archive-collision" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    const archiveRoot = path.join(stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z");

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
      testHooks: {
        afterImport: () => {
          fsSync.mkdirSync(archiveRoot);
          fsSync.writeFileSync(path.join(archiveRoot, "unrelated"), "keep");
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed archiving verified legacy");
    await expect(fs.stat(sourceDir)).resolves.toBeDefined();
    await expect(fs.stat(archiveRoot)).resolves.toBeDefined();
    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    expect(database.prepare("SELECT COUNT(*) AS count FROM migration_sources").get()).toEqual({
      count: 0,
    });
  });

  it("restores idempotently when a canonical exporter recreated the destination", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const sourceRoot = path.join(stateDir, "transcripts");
    const archivedStateDir = tempDirs.make("openclaw-meeting-transcripts-archive-");
    const archivedSessionDir = await seedLegacySession({
      stateDir: archivedStateDir,
      sessionId: "recreated-export",
    });
    const archiveRoot = path.join(archivedStateDir, "transcripts");
    const destination = path.join(sourceRoot, "2026-07-01", "recreated-export");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(archivedSessionDir, destination, { recursive: true });

    await expect(
      restoreCanonicalMeetingTranscriptExports({
        sourceRoot,
        archiveRoot,
        migratedSourcePaths: [],
        canonicalRelativeDirs: [path.join("2026-07-01", "recreated-export")],
      }),
    ).resolves.toBeUndefined();
    await expect(fs.stat(path.join(destination, "metadata.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(archivedSessionDir, "metadata.json"))).resolves.toBeDefined();
  });

  it("rejects canonical restore paths that normalize outside their roots", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const sourceRoot = path.join(stateDir, "transcripts");
    const archiveRoot = path.join(stateDir, "transcripts.migrated-test");
    await fs.mkdir(archiveRoot, { recursive: true });

    await expect(
      restoreCanonicalMeetingTranscriptExports({
        sourceRoot,
        archiveRoot,
        migratedSourcePaths: [],
        canonicalRelativeDirs: [path.join("safe", "..", "..", "outside")],
      }),
    ).rejects.toThrow("escaped its root");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked ancestors during canonical export restore",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
      const archiveRoot = path.join(stateDir, "transcripts.migrated-test");
      const externalRoot = tempDirs.make("openclaw-meeting-transcripts-external-");
      await fs.mkdir(path.join(archiveRoot), { recursive: true });
      await seedLegacySession({ stateDir: externalRoot, sessionId: "linked-export" });
      await fs.symlink(
        path.join(externalRoot, "transcripts", "2026-07-01"),
        path.join(archiveRoot, "2026-07-01"),
        "dir",
      );

      await expect(
        restoreCanonicalMeetingTranscriptExports({
          sourceRoot: path.join(stateDir, "transcripts"),
          archiveRoot,
          migratedSourcePaths: [],
          canonicalRelativeDirs: [path.join("2026-07-01", "linked-export")],
        }),
      ).rejects.toThrow(/symlink/i);
    },
  );

  it("chunks large transcript imports while preserving exact order", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({
      stateDir,
      sessionId: "long-meeting",
      utteranceCount: 530,
    });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = await store.readSession("long-meeting");
    const utterances = await store.readUtterancesForSession(session!);
    expect(utterances).toHaveLength(530);
    expect(utterances[0]).toMatchObject({ id: "u-1", text: "First line" });
    expect(utterances.at(-1)).toMatchObject({ id: "u-530", text: "Line 530" });
  });

  it("preserves an existing empty markdown summary", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({
      stateDir,
      sessionId: "empty-summary",
      emptyMarkdown: true,
      omitSummaryJson: true,
    });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = await store.readSession("empty-summary");
    await expect(store.readSummary(session!)).resolves.toEqual({ markdown: "" });
  });

  it("resumes an interruption after the import commit", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const nativeSession = {
      sessionId: "modified-before-interruption",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    await store.writeSession(nativeSession);
    const nativeArtifacts = await store.materializeSessionArtifacts(nativeSession, "metadata");
    await fs.appendFile(nativeArtifacts.metadataPath, " ");
    await seedLegacySession({ stateDir, sessionId: "interrupted-import" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const interrupted = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      testHooks: {
        afterImport: () => {
          throw new Error("interrupted");
        },
      },
    });
    expect(interrupted.warnings.join("\n")).toContain("interrupted");
    expect(interrupted.changes.join("\n")).toContain("modified meeting transcript export");

    const pending = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(pending.pendingImportCount).toBe(1);
    const resumed = await migrateLegacyMeetingTranscripts({
      detected: pending,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes.join("\n")).toContain("Resumed and archived");
  });

  it("refuses to archive a new legacy session added after a pending import", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({ stateDir, sessionId: "pending-original" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      testHooks: {
        afterImport: () => {
          throw new Error("interrupted");
        },
      },
    });
    const lateDir = await seedLegacySession({ stateDir, sessionId: "pending-late" });

    const pending = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    const resumed = await migrateLegacyMeetingTranscripts({
      detected: pending,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(resumed.changes).toEqual([]);
    expect(resumed.warnings.join("\n")).toContain("session tree changed before archive");
    await expect(fs.stat(lateDir)).resolves.toBeDefined();
  });

  it("finalizes receipts after interruption following the archive move", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const nativeSession = {
      sessionId: "native-export-during-resume",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    await store.writeSession(nativeSession);
    await store.materializeSessionArtifacts(nativeSession, "metadata");
    await seedLegacySession({ stateDir, sessionId: "interrupted-archive" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const interrupted = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
      testHooks: {
        afterArchive: () => {
          throw new Error("interrupted");
        },
      },
    });
    expect(interrupted.warnings.join("\n")).toContain("interrupted");

    const pending = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(pending).toMatchObject({ hasLegacy: true, pendingImportCount: 1 });
    const resumed = await migrateLegacyMeetingTranscripts({
      detected: pending,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes.join("\n")).toContain("Finalized interrupted");
    await expect(fs.stat(store.sessionDir(nativeSession))).resolves.toBeDefined();
    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    expect(
      database
        .prepare("SELECT status, removed_source FROM migration_sources WHERE migration_kind = ?")
        .get("meeting-transcripts-files-v1"),
    ).toEqual({ status: "archived", removed_source: 1 });
  });

  it("does not reimport or archive explicit canonical exports", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    await seedLegacySession({ stateDir, sessionId: "design-review" });
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    await migrateLegacyMeetingTranscripts({ detected, env: databaseEnv(stateDir), stateDir });
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = await store.readSession("design-review");
    await store.materializeSessionArtifacts(session!, "all");

    const rerunDetected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    const rerun = await migrateLegacyMeetingTranscripts({
      detected: rerunDetected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(rerun).toEqual({ changes: [], warnings: [] });
    await expect(
      fs.stat(path.join(stateDir, "transcripts", "2026-07-01", "design-review")),
    ).resolves.toBeDefined();
  });

  it("does not classify an interrupted export of an advancing transcript as legacy", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = {
      sessionId: "advancing-export",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "first" });
    await store.materializeSessionArtifacts(session, "transcript");
    await store.appendUtteranceForSession(session, { text: "second" });

    const database = openOpenClawStateDatabase({ env: databaseEnv(stateDir) }).db;
    database
      .prepare(
        "UPDATE meeting_transcript_sessions SET export_pending_json = ? WHERE session_id = ?",
      )
      .run('["transcript.jsonl"]', session.sessionId);
    await fs.writeFile(path.join(store.sessionDir(session), "transcript.jsonl"), '{"text":');

    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: false });
    await expect(
      migrateLegacyMeetingTranscripts({ detected, env: databaseEnv(stateDir), stateDir }),
    ).resolves.toEqual({ changes: [], warnings: [] });

    await store.materializeSessionArtifacts(session, "transcript");
    const exported = await fs.readFile(
      path.join(store.sessionDir(session), "transcript.jsonl"),
      "utf8",
    );
    expect(
      exported
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).text),
    ).toEqual(["first", "second"]);
  });

  it("migrates legacy sessions while preserving coexisting SQLite exports", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const nativeSession = {
      sessionId: "native-export",
      title: "Native export",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    const nativeUtterance = { text: "SQLite-native line" };
    const nativeUtterances = [nativeUtterance];
    await store.writeSession(nativeSession);
    await store.appendUtteranceForSession(nativeSession, nativeUtterance);
    await store.writeSummary(
      summarizeTranscripts({ session: nativeSession, utterances: nativeUtterances }),
      nativeSession,
    );
    await store.materializeSessionArtifacts(nativeSession, "all");
    const nativeExport = path.join(
      stateDir,
      "transcripts",
      "2026-07-02",
      "native-export",
      "metadata.json",
    );
    const nativeTranscriptExport = path.join(path.dirname(nativeExport), "transcript.jsonl");
    await fs.rm(nativeExport);
    expect(
      detectLegacyMeetingTranscripts({
        stateDir,
        env: databaseEnv(stateDir),
        doctorOnlyStateMigrations: true,
      }),
    ).toMatchObject({ hasLegacy: false });
    await seedLegacySession({ stateDir, sessionId: "legacy-alongside-export" });

    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.stat(nativeExport)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(nativeTranscriptExport)).resolves.toBeDefined();
    await expect(store.readSession("native-export")).resolves.toMatchObject({
      sessionId: "native-export",
    });
    await expect(store.readSession("legacy-alongside-export")).resolves.toMatchObject({
      sessionId: "legacy-alongside-export",
    });
  });

  it("does not trust a DB selector when exported bytes diverge", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = {
      sessionId: "modified-export",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    await store.writeSession(session);
    await store.materializeSessionArtifacts(session, "metadata");
    await fs.appendFile(
      path.join(stateDir, "transcripts", "2026-07-02", "modified-export", "metadata.json"),
      " ",
    );

    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: true });

    const recovered = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });

    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes.join("\n")).toContain("modified meeting transcript export");
    const metadata = await fs.readFile(
      path.join(stateDir, "transcripts", "2026-07-02", "modified-export", "metadata.json"),
      "utf8",
    );
    expect(metadata.endsWith("\n")).toBe(true);
    expect(
      (await fs.readdir(stateDir)).some((entry) =>
        entry.startsWith("transcripts.exports-recovered-"),
      ),
    ).toBe(true);
  });

  it("resolves a case-renamed export directory by metadata identity", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-doctor-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: databaseEnv(stateDir),
    });
    const session = {
      sessionId: "Capital",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-02T10:00:00.000Z",
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "case-stable transcript" });
    const artifacts = await store.materializeSessionArtifacts(session, "transcript");
    const renamedDir = path.join(stateDir, "transcripts", "2026-07-02", "capital");
    await fs.rename(artifacts.sessionDir, renamedDir);
    await fs.rename(path.join(renamedDir, "metadata.json"), path.join(renamedDir, "METADATA.JSON"));

    expect(
      detectLegacyMeetingTranscripts({
        stateDir,
        env: databaseEnv(stateDir),
        doctorOnlyStateMigrations: true,
      }),
    ).toMatchObject({ hasLegacy: false });
    await fs.rm(path.join(renamedDir, "METADATA.JSON"));
    const metadataLessDetected = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(metadataLessDetected.hasLegacy).toBe(!fsSync.existsSync(artifacts.sessionDir));
    await fs.writeFile(
      path.join(renamedDir, "METADATA.JSON"),
      `${JSON.stringify(session, null, 2)}\n `,
    );
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      env: databaseEnv(stateDir),
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);

    const recovered = await migrateLegacyMeetingTranscripts({
      detected,
      env: databaseEnv(stateDir),
      stateDir,
    });
    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes.join("\n")).toContain("modified meeting transcript export");
    await expect(store.readSession("2026-07-02/Capital")).resolves.toMatchObject({
      sessionId: "Capital",
    });
  });
});
