// Stores meeting-capture transcripts in the shared SQLite state database.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOptionalIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  isCaseSensitiveDirectory,
  legacyTranscriptSessionSelector,
  normalizeExportText,
  removeTranscriptArtifact,
  safeTranscriptPathSegment,
  TRANSCRIPT_EXPORT_FILE_NAMES,
  transcriptSessionExportKey,
  transcriptSessionSelector,
  writeTranscriptArtifact,
} from "./store-artifacts.js";
import { writeTranscriptJsonlArtifact } from "./store-export-jsonl.js";
import {
  assertTranscriptExportPathAvailable,
  hasAliasedCanonicalTranscriptExportPathOwner,
} from "./store-export-ownership.js";
import {
  appendMeetingTranscriptUtterance,
  meetingTranscriptDb,
  type MeetingTranscriptSessionRow,
  sessionFromRow,
  summaryFromRow,
  utteranceFromRow,
} from "./store-sqlite.js";
import type * as StoreTypes from "./store-types.js";
import type { TranscriptsSummary } from "./summary.js";
import { renderTranscriptsMarkdown } from "./summary.js";

export type * from "./store-types.js";
export { safeTranscriptPathSegment, transcriptSessionExportKey, transcriptSessionSelector };

/** Canonical meeting-capture transcript store. Files are explicit exports only. */
export class TranscriptsStore {
  constructor(
    private readonly exportRootDir: string,
    private readonly databaseOptions: OpenClawStateDatabaseOptions = {},
  ) {}

  private database() {
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    return openOpenClawStateDatabase(this.databaseOptions);
  }

  sessionDir(session: TranscriptSessionDescriptor): string {
    return path.join(this.exportRootDir, transcriptSessionSelector(session));
  }

  private entryFromRow(
    row: MeetingTranscriptSessionRow,
    summaryKeys: ReadonlySet<string>,
  ): StoreTypes.TranscriptsSessionEntry {
    const session = sessionFromRow(row);
    const sessionDir = this.sessionDir(session);
    const key = `${session.sessionId}\0${session.startedAt}`;
    return {
      session,
      sessionDir,
      selector: row.selector,
      summaryPath: path.join(sessionDir, "summary.md"),
      hasSummary: summaryKeys.has(key),
    };
  }

  private readSummaryKeys(database: OpenClawStateDatabase): Set<string> {
    const rows = executeSqliteQuerySync(
      database.db,
      meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_summaries")
        .select(["session_id", "session_started_at"]),
    ).rows;
    return new Set(rows.map((row) => `${row.session_id}\0${row.session_started_at}`));
  }

  private hasSummary(database: OpenClawStateDatabase, row: MeetingTranscriptSessionRow): boolean {
    return Boolean(
      executeSqliteQueryTakeFirstSync(
        database.db,
        meetingTranscriptDb(database.db)
          .selectFrom("meeting_transcript_summaries")
          .select("session_id")
          .where("session_id", "=", row.session_id)
          .where("session_started_at", "=", row.started_at)
          .limit(1),
      ),
    );
  }

  private readExportOwnership(session: TranscriptSessionDescriptor): {
    manifest: Record<string, string>;
    pending: Set<string>;
  } {
    const database = this.database();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_sessions")
        .select(["export_manifest_json", "export_pending_json"])
        .where("session_id", "=", session.sessionId)
        .where("started_at", "=", session.startedAt),
    );
    return row
      ? {
          manifest: JSON.parse(row.export_manifest_json) as Record<string, string>,
          pending: new Set(JSON.parse(row.export_pending_json) as string[]),
        }
      : { manifest: {}, pending: new Set() };
  }

  private readSessionByIdentity(
    session: TranscriptSessionDescriptor,
  ): TranscriptSessionDescriptor | undefined {
    const database = this.database();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_sessions")
        .selectAll()
        .where("session_id", "=", session.sessionId)
        .where("started_at", "=", session.startedAt),
    );
    return row ? sessionFromRow(row) : undefined;
  }

  private transcriptRows(session: TranscriptSessionDescriptor) {
    const database = this.database();
    return {
      database,
      query: meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_utterances")
        .selectAll()
        .where("session_id", "=", session.sessionId)
        .where("session_started_at", "=", session.startedAt)
        .orderBy("sequence", "asc"),
    };
  }

  private transcriptJsonlDigest(session: TranscriptSessionDescriptor): string {
    const { database, query } = this.transcriptRows(session);
    const digest = createHash("sha256");
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      digest.update(`${JSON.stringify(utteranceFromRow(row))}\n`);
    }
    return digest.digest("hex");
  }

  private async expectedExportHashes(
    session: TranscriptSessionDescriptor,
  ): Promise<Record<string, string>> {
    const storedSession = this.readSessionByIdentity(session);
    if (!storedSession) {
      return {};
    }
    const hashes: Record<string, string> = {
      "metadata.json": sha256Hex(`${JSON.stringify(storedSession, null, 2)}\n`),
    };
    hashes["transcript.jsonl"] = this.transcriptJsonlDigest(storedSession);
    const summary = await this.readSummary(storedSession);
    if (summary.summary) {
      hashes["summary.json"] = sha256Hex(`${JSON.stringify(summary.summary, null, 2)}\n`);
    }
    if (summary.markdown !== undefined) {
      hashes["summary.md"] = sha256Hex(normalizeExportText(summary.markdown));
    }
    return hashes;
  }

  private updateExportManifest(
    session: TranscriptSessionDescriptor,
    exportedHashes: Readonly<Record<string, string>>,
    removedExports: ReadonlySet<string> = new Set(),
  ): void {
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const db = meetingTranscriptDb(database);
        const stored = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("meeting_transcript_sessions")
            .select(["export_manifest_json", "export_pending_json"])
            .where("session_id", "=", session.sessionId)
            .where("started_at", "=", session.startedAt),
        );
        const manifest = stored
          ? (JSON.parse(stored.export_manifest_json) as Record<string, string>)
          : {};
        const pending = new Set(stored ? (JSON.parse(stored.export_pending_json) as string[]) : []);
        for (const fileName of removedExports) {
          delete manifest[fileName];
        }
        for (const fileName of [...Object.keys(exportedHashes), ...removedExports]) {
          pending.delete(fileName);
        }
        executeSqliteQuerySync(
          database,
          db
            .updateTable("meeting_transcript_sessions")
            .set({
              export_manifest_json: JSON.stringify({ ...manifest, ...exportedHashes }),
              export_pending_json: JSON.stringify([...pending].toSorted()),
            })
            .where("session_id", "=", session.sessionId)
            .where("started_at", "=", session.startedAt),
        );
      },
      this.databaseOptions,
      { operationLabel: "meeting-transcripts.export.record" },
    );
  }

  private markPendingExports(session: TranscriptSessionDescriptor, fileNames: string[]): void {
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const db = meetingTranscriptDb(database);
        const stored = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("meeting_transcript_sessions")
            .select("export_pending_json")
            .where("session_id", "=", session.sessionId)
            .where("started_at", "=", session.startedAt),
        );
        if (!stored) {
          throw new Error(`transcripts session not found: ${session.sessionId}`);
        }
        const pending = new Set(JSON.parse(stored.export_pending_json) as string[]);
        for (const fileName of fileNames) {
          pending.add(fileName);
        }
        executeSqliteQuerySync(
          database,
          db
            .updateTable("meeting_transcript_sessions")
            .set({ export_pending_json: JSON.stringify([...pending].toSorted()) })
            .where("session_id", "=", session.sessionId)
            .where("started_at", "=", session.startedAt),
        );
      },
      this.databaseOptions,
      { operationLabel: "meeting-transcripts.export.pending" },
    );
  }

  private async assertExportDestinationOwned(
    session: TranscriptSessionDescriptor,
    sessionDir = this.sessionDir(session),
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(sessionDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const ownership = this.readExportOwnership(session);
    const caseSensitive = await isCaseSensitiveDirectory(sessionDir);
    let expectedHashes: Record<string, string> | undefined;
    const repairedHashes: Record<string, string> = {};
    for (const entry of entries) {
      const canonicalName = caseSensitive ? entry.name : entry.name.toLowerCase();
      if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName)) {
        continue;
      }
      const filePath = path.join(sessionDir, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `legacy transcript artifacts require migration before writing ${sessionDir}; run openclaw doctor --fix`,
        );
      }
      const actualHash = await sha256File(filePath);
      if (
        ownership.manifest[canonicalName] === actualHash ||
        ownership.pending.has(canonicalName)
      ) {
        continue;
      }
      expectedHashes ??= await this.expectedExportHashes(session);
      if (expectedHashes[canonicalName] !== actualHash) {
        throw new Error(
          `legacy transcript artifacts require migration before writing ${sessionDir}; run openclaw doctor --fix`,
        );
      }
      repairedHashes[canonicalName] = actualHash;
    }
    if (Object.keys(repairedHashes).length > 0) {
      this.updateExportManifest(session, repairedHashes);
    }
  }

  async listSessionEntries(): Promise<StoreTypes.TranscriptsSessionEntry[]> {
    const database = this.database();
    const rows = executeSqliteQuerySync(
      database.db,
      meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_sessions")
        .selectAll()
        .orderBy("started_at", "desc")
        .orderBy("session_id", "asc"),
    ).rows;
    const summaryKeys = this.readSummaryKeys(database);
    return rows.map((row) => this.entryFromRow(row, summaryKeys));
  }

  async writeSession(session: TranscriptSessionDescriptor): Promise<void> {
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    if (
      !this.readSessionByIdentity(session) &&
      !(await hasAliasedCanonicalTranscriptExportPathOwner({
        session,
        exportRootDir: this.exportRootDir,
        databaseOptions: this.databaseOptions,
      }))
    ) {
      await this.assertExportDestinationOwned(session);
      const legacySessionDir = path.join(
        this.exportRootDir,
        legacyTranscriptSessionSelector(session),
      );
      const legacyOwner = await this.readSession(legacyTranscriptSessionSelector(session));
      const legacyPathIsCanonical =
        legacyOwner !== undefined &&
        path.resolve(this.sessionDir(legacyOwner)) === path.resolve(legacySessionDir);
      if (
        path.resolve(legacySessionDir) !== path.resolve(this.sessionDir(session)) &&
        !legacyPathIsCanonical
      ) {
        await this.assertExportDestinationOwned(session, legacySessionDir);
      }
    }
    const selector = transcriptSessionSelector(session);
    const sourceJson = JSON.stringify(session.source);
    const metadataJson = session.metadata ? JSON.stringify(session.metadata) : null;
    const now = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const db = meetingTranscriptDb(database);
        executeSqliteQuerySync(
          database,
          db
            .insertInto("meeting_transcript_sessions")
            .values({
              session_id: session.sessionId,
              started_at: session.startedAt,
              selector,
              export_key: transcriptSessionExportKey(session),
              session_slug: safeTranscriptPathSegment(session.sessionId),
              provider_id: session.source.providerId,
              title: session.title ?? null,
              source_json: sourceJson,
              stopped_at: session.stoppedAt ?? null,
              metadata_json: metadataJson,
              export_manifest_json: "{}",
              export_pending_json: "[]",
              next_utterance_seq: 0,
              created_at_ms: now,
              updated_at_ms: now,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_id", "started_at"]).doUpdateSet({
                selector,
                export_key: transcriptSessionExportKey(session),
                session_slug: safeTranscriptPathSegment(session.sessionId),
                provider_id: session.source.providerId,
                title: session.title ?? null,
                source_json: sourceJson,
                stopped_at: session.stoppedAt ?? null,
                metadata_json: metadataJson,
                updated_at_ms: now,
              }),
            ),
        );
      },
      this.databaseOptions,
      { operationLabel: "meeting-transcripts.session.write" },
    );
  }

  async readSession(sessionSelector: string): Promise<TranscriptSessionDescriptor | undefined> {
    return (await this.readSessionEntry(sessionSelector))?.session;
  }

  async readSessionEntry(
    sessionSelector: string,
  ): Promise<StoreTypes.TranscriptsSessionEntry | undefined> {
    const database = this.database();
    const db = meetingTranscriptDb(database.db);
    const qualified = /^\d{4}-\d{2}-\d{2}\//u.test(sessionSelector);
    const exactRows = qualified
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("meeting_transcript_sessions")
            .selectAll()
            .where("selector", "=", sessionSelector),
        ).rows
      : executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("meeting_transcript_sessions")
            .selectAll()
            .where("session_id", "=", sessionSelector)
            .orderBy("started_at", "desc")
            .limit(2),
        ).rows;
    const slugRows = qualified
      ? []
      : executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("meeting_transcript_sessions")
            .selectAll()
            .where("session_slug", "=", sessionSelector)
            .orderBy("started_at", "desc")
            .limit(2),
        ).rows;
    const rows = [
      ...new Map(
        [...exactRows, ...slugRows].map((row) => [`${row.session_id}\0${row.started_at}`, row]),
      ).values(),
    ];
    if (rows.length > 1) {
      throw new Error(
        `multiple transcripts sessions match ${sessionSelector}; use one of: ${rows
          .map((row) => row.selector)
          .join(", ")}`,
      );
    }
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const summaryKeys = this.hasSummary(database, row)
      ? new Set([`${row.session_id}\0${row.started_at}`])
      : new Set<string>();
    return this.entryFromRow(row, summaryKeys);
  }

  async appendUtteranceForSession(
    session: TranscriptSessionDescriptor,
    utterance: TranscriptUtterance,
  ): Promise<void> {
    const metadataJson = utterance.metadata ? JSON.stringify(utterance.metadata) : null;
    const now = Date.now();
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    runOpenClawStateWriteTransaction(
      ({ db: database }) =>
        appendMeetingTranscriptUtterance({ database, metadataJson, now, session, utterance }),
      this.databaseOptions,
      { operationLabel: "meeting-transcripts.utterance.append" },
    );
  }

  async readUtterancesForSession(
    session: TranscriptSessionDescriptor,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    const database = this.database();
    const maxUtterances = resolveOptionalIntegerOption(options.maxUtterances, { min: 1 });
    const query = meetingTranscriptDb(database.db)
      .selectFrom("meeting_transcript_utterances")
      .selectAll()
      .where("session_id", "=", session.sessionId)
      .where("session_started_at", "=", session.startedAt);
    if (maxUtterances === undefined) {
      return executeSqliteQuerySync(database.db, query.orderBy("sequence", "asc")).rows.map(
        utteranceFromRow,
      );
    }
    return executeSqliteQuerySync(
      database.db,
      query.orderBy("sequence", "desc").limit(maxUtterances),
    )
      .rows.toReversed()
      .map(utteranceFromRow);
  }

  async updateStopped(sessionSelector: string, stoppedAt: string): Promise<void> {
    const entry = await this.readSessionEntry(sessionSelector);
    if (!entry) {
      return;
    }
    await this.writeSession({ ...entry.session, stoppedAt });
  }

  async writeSummary(
    summary: TranscriptsSummary,
    session?: TranscriptSessionDescriptor,
  ): Promise<string> {
    const resolved = session ?? (await this.readSession(summary.sessionId));
    if (!resolved) {
      throw new Error(`transcripts session not found: ${summary.sessionId}`);
    }
    const summaryJson = JSON.stringify(summary);
    const markdown = renderTranscriptsMarkdown(summary);
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const db = meetingTranscriptDb(database);
        executeSqliteQuerySync(
          database,
          db
            .insertInto("meeting_transcript_summaries")
            .values({
              session_id: resolved.sessionId,
              session_started_at: resolved.startedAt,
              generated_at: summary.generatedAt,
              summary_json: summaryJson,
              markdown,
              utterance_count: summary.utteranceCount,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_id", "session_started_at"]).doUpdateSet({
                generated_at: summary.generatedAt,
                summary_json: summaryJson,
                markdown,
                utterance_count: summary.utteranceCount,
              }),
            ),
        );
      },
      this.databaseOptions,
      { operationLabel: "meeting-transcripts.summary.write" },
    );
    return path.join(this.sessionDir(resolved), "summary.md");
  }

  async readSummary(
    session: TranscriptSessionDescriptor,
  ): Promise<{ summary?: TranscriptsSummary; markdown?: string }> {
    const database = this.database();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      meetingTranscriptDb(database.db)
        .selectFrom("meeting_transcript_summaries")
        .selectAll()
        .where("session_id", "=", session.sessionId)
        .where("session_started_at", "=", session.startedAt),
    );
    if (!row) {
      return {};
    }
    const summary = summaryFromRow(row);
    return {
      ...(summary ? { summary } : {}),
      ...(row.markdown !== null ? { markdown: row.markdown } : {}),
    };
  }

  async materializeSessionArtifacts(
    sessionOrSelector: TranscriptSessionDescriptor | string,
    kind: StoreTypes.TranscriptArtifactKind,
  ): Promise<StoreTypes.MaterializedTranscriptArtifacts> {
    const session =
      typeof sessionOrSelector === "string"
        ? await this.readSession(sessionOrSelector)
        : this.readSessionByIdentity(sessionOrSelector);
    if (!session) {
      const selector =
        typeof sessionOrSelector === "string" ? sessionOrSelector : sessionOrSelector.sessionId;
      throw new Error(`transcripts session not found: ${selector}`);
    }
    return await withOpenClawStateLease(
      {
        scope: "meeting-transcript.export",
        key: transcriptSessionExportKey(session),
        database: { scope: "shared", options: this.databaseOptions },
        leaseMs: 60_000,
        waitMs: 10_000,
        leaseLabel: "meeting transcript export lease",
        operationLabel: "meeting-transcripts.export.lease",
      },
      async () => await this.materializeSessionArtifactsOwned(session, kind),
    );
  }

  private async materializeSessionArtifactsOwned(
    session: TranscriptSessionDescriptor,
    kind: StoreTypes.TranscriptArtifactKind,
  ): Promise<StoreTypes.MaterializedTranscriptArtifacts> {
    const sessionDir = this.sessionDir(session);
    const metadataPath = path.join(sessionDir, "metadata.json");
    const transcriptPath = path.join(sessionDir, "transcript.jsonl");
    const summaryJsonPath = path.join(sessionDir, "summary.json");
    const summaryPath = path.join(sessionDir, "summary.md");
    // Every export starts with identity metadata, so even an interrupted partial
    // materialization remains inspectable by Doctor without guessing its owner.
    const includeMetadata = true;
    const includeTranscript = kind === "all" || kind === "transcript";
    const includeSummary = kind === "all" || kind === "summary";
    const storedSummary = includeSummary ? await this.readSummary(session) : {};
    const exportedHashes: Record<string, string> = {};
    const removedExports = new Set<string>();
    await assertTranscriptExportPathAvailable({
      session,
      exportRootDir: this.exportRootDir,
      databaseOptions: this.databaseOptions,
    });
    await this.assertExportDestinationOwned(session);
    const pendingFiles = [
      "metadata.json",
      ...(includeTranscript ? ["transcript.jsonl"] : []),
      ...(includeSummary ? ["summary.json", "summary.md"] : []),
    ];
    this.markPendingExports(session, pendingFiles);
    const ensured = await ensureAbsoluteDirectory(sessionDir, {
      mode: 0o700,
      scopeLabel: "transcript export directory",
    });
    if (!ensured.ok) {
      throw ensured.error;
    }
    if (includeMetadata) {
      exportedHashes["metadata.json"] = await writeTranscriptArtifact(
        sessionDir,
        "metadata.json",
        `${JSON.stringify(session, null, 2)}\n`,
      );
    }
    if (includeTranscript) {
      exportedHashes["transcript.jsonl"] = await writeTranscriptJsonlArtifact({
        sessionDir,
        session,
        databaseOptions: this.databaseOptions,
      });
    }
    if (includeSummary) {
      if (storedSummary.summary) {
        exportedHashes["summary.json"] = await writeTranscriptArtifact(
          sessionDir,
          "summary.json",
          `${JSON.stringify(storedSummary.summary, null, 2)}\n`,
        );
      } else {
        await removeTranscriptArtifact(sessionDir, "summary.json");
        removedExports.add("summary.json");
      }
      if (storedSummary.markdown !== undefined) {
        exportedHashes["summary.md"] = await writeTranscriptArtifact(
          sessionDir,
          "summary.md",
          normalizeExportText(storedSummary.markdown),
        );
      } else {
        await removeTranscriptArtifact(sessionDir, "summary.md");
        removedExports.add("summary.md");
      }
    }
    if (Object.keys(exportedHashes).length > 0 || removedExports.size > 0) {
      this.updateExportManifest(session, exportedHashes, removedExports);
    }
    return {
      sessionDir,
      metadataPath,
      transcriptPath,
      summaryJsonPath,
      summaryPath,
      hasSummary: storedSummary.summary !== undefined || storedSummary.markdown !== undefined,
    };
  }
}
