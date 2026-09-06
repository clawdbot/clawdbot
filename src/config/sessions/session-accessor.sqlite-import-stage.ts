// Disposable migration spool: never registered, resumed, or read by the runtime.
import { hash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIndexedSessionEntry } from "../../agents/sessions/session-manager-codec.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createPrivateSqliteTempDirectorySync } from "../../infra/sqlite-private-directory.js";
import {
  normalizeLegacyOpenAICodexTranscriptMetadata,
  transcriptRepairUserKey,
} from "./legacy-transcript-repair.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  scanSessionTranscriptNavigation,
  isSessionTranscriptLeafControl,
  isCanonicalSessionTranscriptEntry,
  type SessionTranscriptTreeNode,
} from "./transcript-tree.js";

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
      CREATE TABLE tree (id TEXT PRIMARY KEY, node_json TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE tree_sets (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, id)) WITHOUT ROWID;
      CREATE TABLE selected (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, parent_id TEXT, visible INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE user_keys (id TEXT PRIMARY KEY, visible_key TEXT, stripped_key TEXT) WITHOUT ROWID;
      CREATE INDEX user_keys_visible ON user_keys(visible_key);
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
  private rejected = false;

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
    this.rejected = false;
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
      } else {
        this.rejected = true;
      }
    }
  }

  contains(eventJson: string): boolean {
    return this.findSeen.get(hash("sha256", eventJson, "buffer"), eventJson) !== undefined;
  }

  get complete(): boolean {
    return !this.rejected;
  }

  addSeen(eventJson: string): void {
    this.insertSeen.run(hash("sha256", eventJson, "buffer"), eventJson);
  }

  /** Plan branch repair on disk; only one transcript payload is decoded at a time. */
  repairLegacyTranscript(source: number): {
    repaired: boolean;
    events: number;
    recognized: boolean;
  } {
    this.database.exec(
      "DELETE FROM tree; DELETE FROM tree_sets; DELETE FROM selected; DELETE FROM user_keys;",
    );
    type Node = SessionTranscriptTreeNode<Record<string, unknown>>;
    const put = this.database.prepare("INSERT OR REPLACE INTO tree VALUES (?, ?)");
    const get = this.database.prepare("SELECT node_json FROM tree WHERE id = ?");
    const lookup = (id: string): Node | undefined => {
      const row = get.get(id);
      // SAFETY: tree is private scratch data written exclusively from the typed scanner below.
      return row ? (JSON.parse(String(row.node_json)) as Node) : undefined;
    };
    const setInsert = this.database.prepare("INSERT OR IGNORE INTO tree_sets VALUES (?, ?)");
    const setHas = this.database.prepare("SELECT 1 FROM tree_sets WHERE kind = ? AND id = ?");
    const setClear = this.database.prepare("DELETE FROM tree_sets WHERE kind = ?");
    const diskSet = (kind: string) => ({
      add: (id: string) => {
        setInsert.run(kind, id);
      },
      has: (id: string) => setHas.get(kind, id) !== undefined,
      clear: () => {
        setClear.run(kind);
      },
    });
    const repeatedRows = diskSet("repeated");
    const user = this.database.prepare("INSERT OR REPLACE INTO user_keys VALUES (?, ?, ?)");
    const readRow = this.database.prepare(
      "SELECT event_json FROM rows WHERE source = ? AND seq = ?",
    );
    const update = this.database.prepare(
      "UPDATE rows SET event_json = ? WHERE source = ? AND seq = ?",
    );
    let changed = false;
    let recognized = true;
    let headerSeq: number | undefined;
    let lastEntry: Record<string, unknown> | undefined;
    let terminalControl: Node | undefined;
    const rows = this.rows(source);
    function* entries() {
      for (const row of rows) {
        const entry: unknown = JSON.parse(row.eventJson);
        let eventJson = row.eventJson;
        if (!isRecord(entry)) {
          recognized = false;
          continue;
        }
        if (normalizeLegacyOpenAICodexTranscriptMetadata([entry]) > 0) {
          eventJson = JSON.stringify(entry);
          update.run(eventJson, source, row.seq);
          changed = true;
        }
        if (entry.type === "session") {
          if (headerSeq !== undefined || typeof entry.id !== "string") {
            recognized = false;
          }
          headerSeq ??= row.seq;
          continue;
        }
        const visibleKey = transcriptRepairUserKey(entry, false);
        const strippedKey = transcriptRepairUserKey(entry, true);
        if (typeof entry.id === "string" && (visibleKey || strippedKey)) {
          user.run(
            entry.id,
            visibleKey?.slice(visibleKey.indexOf("\0") + 1) ?? null,
            strippedKey ?? null,
          );
        }
        const indexed = isIndexedSessionEntry(entry);
        const leafControl = isSessionTranscriptLeafControl(entry);
        // Unknown payload stays in the original, never silently declared complete.
        if (!indexed && !leafControl) {
          recognized = false;
        }
        if (typeof entry.id === "string" && (indexed || leafControl)) {
          const previous = lookup(entry.id);
          if (previous) {
            const previousRow = readRow.get(source, Number(previous.entry.importSeq));
            if (previousRow && String(previousRow.event_json) === eventJson) {
              repeatedRows.add(String(row.seq));
              changed = true;
              continue;
            }
          }
        }
        const metadata = { ...entry };
        delete metadata.message;
        // Navigation needs only these fields, never a tool result or opaque payload.
        const navigation: Record<string, unknown> = {};
        for (const key of ["type", "id", "parentId", "targetId", "appendParentId", "appendMode"]) {
          if (Object.hasOwn(metadata, key)) {
            navigation[key] = metadata[key];
          }
        }
        lastEntry = navigation;
        yield { ...navigation, importSeq: row.seq };
      }
    }
    const navigation = scanSessionTranscriptNavigation<Record<string, unknown>>(entries(), {
      byId: {
        get: lookup,
        has: (id) => get.get(id) !== undefined,
        set: (id, node) => {
          // A later duplicate can hide a different original payload during branch selection.
          if (get.get(id)) {
            recognized = false;
          }
          put.run(id, JSON.stringify(node));
        },
      },
      addNode: (node) => {
        if (node.leafId !== undefined) {
          terminalControl = isSessionTranscriptLeafControl(node.entry) ? node : undefined;
        }
      },
      resetDescendantIds: diskSet("reset"),
      invalidLeafControlIds: diskSet("invalid"),
    });
    this.database
      .prepare(
        `DELETE FROM rows WHERE source = ? AND CAST(seq AS TEXT) IN (
          SELECT id FROM tree_sets WHERE kind = 'repeated'
        )`,
      )
      .run(source);
    const select = this.database.prepare("INSERT OR REPLACE INTO selected VALUES (?, ?, ?, ?)");
    const selected = this.database.prepare("SELECT 1 FROM selected WHERE id = ?");
    const walk = (leaf: string | null, visible: boolean): boolean => {
      const seen = diskSet("walk");
      seen.clear();
      let id = leaf;
      let child: Node | undefined;
      while (id !== null) {
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        const node = lookup(id);
        if (!node) {
          recognized = false;
          break;
        }
        if (!visible && (selected.get(id) || isCanonicalSessionTranscriptEntry(node.entry))) {
          break;
        }
        if (!isSessionTranscriptLeafControl(node.entry)) {
          if (child) {
            select.run(child.id, Number(child.entry.importSeq), node.id, visible ? 1 : 0);
          }
          child = node;
        }
        id = navigation.hasExplicitLeafUpdate
          ? node.parentId
          : typeof node.entry.parentId === "string" && node.entry.parentId.trim()
            ? node.entry.parentId
            : null;
      }
      if (child) {
        select.run(
          child.id,
          Number(child.entry.importSeq),
          visible ? null : navigation.leafId,
          visible ? 1 : 0,
        );
      }
      return true;
    };
    const leaf = navigation.hasExplicitLeafUpdate
      ? navigation.leafId
      : typeof lastEntry?.id === "string"
        ? lastEntry.id
        : null;
    const valid = walk(leaf, true);
    const broken =
      valid &&
      this.database
        .prepare(`
      SELECT 1 FROM user_keys inactive
      JOIN user_keys active
      JOIN selected s ON s.id = active.id AND s.visible = 1
        AND inactive.stripped_key = COALESCE(s.parent_id, '') || char(0) || active.visible_key
      WHERE NOT EXISTS (SELECT 1 FROM selected WHERE id = inactive.id) LIMIT 1
    `)
        .get() !== undefined;
    if (broken && headerSeq !== undefined) {
      if (navigation.hasExplicitLeafUpdate) {
        if (!walk(navigation.appendParentId, false)) {
          recognized = false;
        }
      }
      // Retain the exact header and selected physical rows; rewrite only normalized parent links.
      const chosen = this.database.prepare("SELECT seq, parent_id FROM selected ORDER BY seq");
      for (const selectedRow of chosen.iterate()) {
        const row = readRow.get(source, selectedRow.seq!);
        // SAFETY: selected rows came from the record-checked navigation pass in this spool.
        const event = JSON.parse(String(row!.event_json)) as Record<string, unknown>;
        if (navigation.hasExplicitLeafUpdate) {
          event.parentId = selectedRow.parent_id;
        }
        update.run(JSON.stringify(event), source, selectedRow.seq!);
      }
      let controlSeq: number | null = null;
      if (terminalControl) {
        controlSeq = Number(terminalControl.entry.importSeq);
        const last = this.database
          .prepare("SELECT id FROM selected ORDER BY seq DESC LIMIT 1")
          .get();
        const row = readRow.get(source, controlSeq);
        // SAFETY: selected rows came from the record-checked navigation pass in this spool.
        const event = JSON.parse(String(row!.event_json)) as Record<string, unknown>;
        event.parentId = last?.id ?? null;
        event.appendParentId =
          navigation.appendParentId === null
            ? null
            : selected.get(navigation.appendParentId)
              ? navigation.appendParentId
              : (last?.id ?? null);
        update.run(JSON.stringify(event), source, controlSeq);
        const next = this.database
          .prepare("SELECT MAX(seq) + 1 AS seq FROM rows WHERE source = ?")
          .get(source);
        this.database
          .prepare("UPDATE rows SET seq = ? WHERE source = ? AND seq = ?")
          .run(next!.seq!, source, controlSeq);
        controlSeq = Number(next!.seq);
      }
      this.database
        .prepare(`DELETE FROM rows WHERE source = ? AND seq <> ?
        AND (? IS NULL OR seq <> ?) AND seq NOT IN (SELECT seq FROM selected)`)
        .run(source, headerSeq, controlSeq, controlSeq);
      changed = true;
    }
    if (!valid || navigation.hasInvalidLeafControl || headerSeq === undefined) {
      recognized = false;
    }
    const count = this.database
      .prepare("SELECT COUNT(*) AS count FROM rows WHERE source = ?")
      .get(source);
    return { repaired: changed, events: Number(count!.count), recognized };
  }
}
