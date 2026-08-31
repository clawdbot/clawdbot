// Disposable migration spool: never registered, resumed, or read by the runtime.
import { hash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createPrivateSqliteTempDirectorySync } from "../../infra/sqlite-private-directory.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";

type StagedTranscriptRow = { seq: number; eventJson: string; createdAt: number | null };

export function withSqliteSessionImportStage<T>(run: (stage: SqliteSessionImportStage) => T): T {
  const directory = createPrivateSqliteTempDirectorySync(os.tmpdir(), "openclaw-session-import-");
  let database: DatabaseSync | undefined;
  try {
    const filename = path.join(directory, "transcripts.sqlite");
    fs.closeSync(fs.openSync(filename, "wx", 0o600));
    database = openNodeSqliteDatabase(filename);
    // The spool is discarded even on failure. Keep SQLite's page cache and temporary
    // work on disk; transcript bytes must not move from a JS array to a native heap.
    database.exec(`
      PRAGMA cache_size = -2048;
      PRAGMA temp_store = FILE;
      CREATE TABLE rows (
        source INTEGER NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL,
        created_at INTEGER, PRIMARY KEY (source, seq)
      ) WITHOUT ROWID;
      CREATE TABLE seen (hash BLOB NOT NULL, event_json TEXT NOT NULL);
      CREATE INDEX seen_hash ON seen(hash);
      BEGIN;
    `);
    return run(new SqliteSessionImportStage(database));
  } finally {
    try {
      database?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

export class SqliteSessionImportStage {
  private readonly insert;
  private readonly read;
  private readonly findSeen;
  private readonly insertSeen;

  constructor(private readonly database: DatabaseSync) {
    this.insert = database.prepare("INSERT INTO rows VALUES (?, ?, ?, ?)");
    this.read = database.prepare(
      "SELECT seq, event_json AS eventJson, created_at AS createdAt FROM rows WHERE source = ? ORDER BY seq",
    );
    this.findSeen = database.prepare(
      "SELECT 1 FROM seen WHERE hash = ? AND event_json = ? LIMIT 1",
    );
    this.insertSeen = database.prepare("INSERT INTO seen VALUES (?, ?)");
  }

  append(source: number, seq: number, eventJson: string, createdAt: number | null): void {
    this.insert.run(source, seq, eventJson, createdAt);
  }

  rows(source: number): Iterable<StagedTranscriptRow> {
    // SAFETY: this private table is written only by append; the projection preserves its row types.
    return this.read.iterate(source) as Iterable<StagedTranscriptRow>;
  }

  resetSeen(): void {
    this.database.exec("DELETE FROM seen");
  }

  *iterateUnseenEvents(source: number): Generator<TranscriptEvent, void, boolean> {
    for (const row of this.rows(source)) {
      const eventHash = hash("sha256", row.eventJson, "buffer");
      // Hash narrows the lookup; exact bytes decide equality even under a hash collision.
      if (this.findSeen.get(eventHash, row.eventJson) !== undefined) {
        continue;
      }
      // SAFETY: staging serialized the caller's TranscriptEvent without transforming its contents.
      const inserted = yield JSON.parse(row.eventJson) as TranscriptEvent;
      // Rejected identities stay unseen so later attempts retain their window recency writes.
      if (inserted) {
        this.insertSeen.run(eventHash, row.eventJson);
      }
    }
  }

  addSeen(eventJson: string): void {
    this.insertSeen.run(hash("sha256", eventJson, "buffer"), eventJson);
  }
}
