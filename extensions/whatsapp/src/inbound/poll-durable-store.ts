// Whatsapp plugin module persists poll vote-decoding state (ownership +
// cached creation message) durably, so a gateway restart between a poll's
// creation and a vote doesn't lose the ability to recognize/decode that
// vote once WhatsApp redelivers it on reconnect. Uses node:sqlite directly
// (extension-local store, same pattern as logbook/imessage) — the shared
// Kysely helpers and the central openclaw.sqlite schema are core-only.
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { proto } from "baileys";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { BufferJSON } from "../session.runtime.js";

type Database = import("node:sqlite").DatabaseSync;

const POLL_STORE_SCHEMA_VERSION = 1;
const POLL_STORE_SQLITE_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS poll_creations (
  account_id TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, remote_jid, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_whatsapp_poll_creations_expires ON poll_creations (expires_at);
CREATE TABLE IF NOT EXISTS poll_vote_dedup (
  account_id TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  vote_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, remote_jid, vote_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_whatsapp_poll_vote_dedup_expires ON poll_vote_dedup (expires_at);
`;

type PollCreationRow = {
  message_json: string | null;
  expires_at: number;
};

function serializeMessage(message: proto.IMessage): string {
  return JSON.stringify(message, BufferJSON.replacer);
}

function deserializeMessage(json: string): proto.IMessage {
  return JSON.parse(json, BufferJSON.reviver) as proto.IMessage;
}

/**
 * Durable, bounded, extension-local store for WhatsApp poll vote-decoding
 * state. Deliberately separate from the central openclaw.sqlite (no core
 * schema migration needed) — see docs/channels/whatsapp.md for the
 * retention/privacy tradeoffs this makes.
 */
export class WhatsAppPollStore {
  private readonly db: Database;
  private readonly walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const dbPath = path.join(dataDir, "poll-state.sqlite");
    const db = openNodeSqliteDatabase(dbPath);
    let walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
    try {
      chmodSync(dbPath, 0o600);
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: POLL_STORE_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "whatsapp-poll-state",
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      const versionRow = db.prepare("PRAGMA user_version").get() as
        | { user_version?: unknown }
        | undefined;
      const schemaVersion = Number(versionRow?.user_version ?? 0);
      if (schemaVersion > POLL_STORE_SCHEMA_VERSION) {
        throw new Error(
          `WhatsApp poll-state database uses newer schema version ${schemaVersion}; this build supports ${POLL_STORE_SCHEMA_VERSION}`,
        );
      }
      db.exec(SCHEMA);
      if (schemaVersion < POLL_STORE_SCHEMA_VERSION) {
        migrateSqliteSchemaToStrict(db, SCHEMA, { databaseLabel: dbPath });
        db.exec(`PRAGMA user_version = ${POLL_STORE_SCHEMA_VERSION};`);
      }
    } catch (error) {
      walMaintenance?.close();
      db.close();
      throw error;
    }
    this.db = db;
    this.walMaintenance = walMaintenance;
  }

  close(): void {
    this.walMaintenance.close();
    this.db.close();
  }

  /**
   * Marks `remoteJid:messageId` as a poll this account created. Safe to call
   * before the creation message's own content is known (e.g. right after an
   * accepted send, before the messages.upsert echo arrives) — an existing
   * row's `message_json` is preserved; only `expires_at` is extended.
   */
  rememberOwnPollCreation(
    accountId: string,
    remoteJid: string,
    messageId: string,
    ttlMs: number,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO poll_creations (account_id, remote_jid, message_id, message_json, created_at, expires_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(account_id, remote_jid, message_id)
         DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(accountId, remoteJid, messageId, now, now + ttlMs);
  }

  isOwnPollCreation(accountId: string, remoteJid: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT expires_at FROM poll_creations WHERE account_id = ? AND remote_jid = ? AND message_id = ?`,
      )
      .get(accountId, remoteJid, messageId) as { expires_at: number } | undefined;
    return Boolean(row) && row!.expires_at > Date.now();
  }

  /**
   * Persists the poll creation message's own content (including the
   * decryption key in `messageContextInfo.messageSecret`) once its
   * messages.upsert echo arrives. Upserts alongside any ownership row
   * already written by `rememberOwnPollCreation`.
   */
  rememberPollCreationMessage(
    accountId: string,
    remoteJid: string,
    messageId: string,
    message: proto.IMessage,
    ttlMs: number,
  ): void {
    const now = Date.now();
    const messageJson = serializeMessage(message);
    this.db
      .prepare(
        `INSERT INTO poll_creations (account_id, remote_jid, message_id, message_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, remote_jid, message_id)
         DO UPDATE SET message_json = excluded.message_json, expires_at = excluded.expires_at`,
      )
      .run(accountId, remoteJid, messageId, messageJson, now, now + ttlMs);
  }

  readPollCreationMessage(
    accountId: string,
    remoteJid: string,
    messageId: string,
  ): proto.IMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT message_json, expires_at FROM poll_creations WHERE account_id = ? AND remote_jid = ? AND message_id = ?`,
      )
      .get(accountId, remoteJid, messageId) as PollCreationRow | undefined;
    if (!row || row.expires_at <= Date.now() || !row.message_json) {
      return undefined;
    }
    try {
      return deserializeMessage(row.message_json);
    } catch {
      return undefined;
    }
  }

  rememberVoteDedup(accountId: string, remoteJid: string, voteId: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO poll_vote_dedup (account_id, remote_jid, vote_id, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, remote_jid, vote_id) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(accountId, remoteJid, voteId, now + ttlMs);
  }

  isVoteDedup(accountId: string, remoteJid: string, voteId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT expires_at FROM poll_vote_dedup WHERE account_id = ? AND remote_jid = ? AND vote_id = ?`,
      )
      .get(accountId, remoteJid, voteId) as { expires_at: number } | undefined;
    return Boolean(row) && row!.expires_at > Date.now();
  }

  /** Deletes expired rows from both tables. Returns counts for observability. */
  pruneExpired(now = Date.now()): { creations: number; votes: number } {
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const creations = this.db
          .prepare(`DELETE FROM poll_creations WHERE expires_at <= ?`)
          .run(now);
        const votes = this.db.prepare(`DELETE FROM poll_vote_dedup WHERE expires_at <= ?`).run(now);
        return { creations: Number(creations.changes), votes: Number(votes.changes) };
      },
      {
        busyTimeoutMs: POLL_STORE_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "whatsapp-poll-state",
        operationLabel: "whatsapp.poll-state.prune",
      },
    );
  }
}

const storesByPath = new Map<string, WhatsAppPollStore>();

/** Returns a process-cached store instance for `dataDir` (opens on first use). */
export function getWhatsAppPollStore(dataDir: string): WhatsAppPollStore {
  const resolved = path.resolve(dataDir);
  const existing = storesByPath.get(resolved);
  if (existing) {
    return existing;
  }
  const store = new WhatsAppPollStore(resolved);
  storesByPath.set(resolved, store);
  return store;
}
