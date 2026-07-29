import type { DatabaseSync } from "node:sqlite";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { buildConversationRef, normalizeConversationPeerId } from "../routing/conversation-ref.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";

type MigratedConversationEntry = Record<string, unknown>;

function migratedObject(
  entry: MigratedConversationEntry,
  key: string,
): MigratedConversationEntry | undefined {
  const value = entry[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MigratedConversationEntry)
    : undefined;
}

function migratedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseConversationEntry(value: unknown): MigratedConversationEntry | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MigratedConversationEntry)
      : undefined;
  } catch {
    return undefined;
  }
}

function inferMigratedChatType(params: {
  entry: MigratedConversationEntry;
  persistedChatType?: string;
  sessionKey?: string;
  deliveryTarget?: string;
}): ChatType {
  const explicit =
    normalizeChatType(migratedText(params.entry.chatType)) ??
    normalizeChatType(migratedText(params.persistedChatType));
  if (explicit) {
    return explicit;
  }
  const keyType = deriveSessionChatTypeFromKey(params.sessionKey);
  if (keyType !== "unknown") {
    return keyType;
  }
  const target = params.deliveryTarget?.toLowerCase();
  if (target?.startsWith("channel:") || /^[^:]+:channel:/u.test(target ?? "")) {
    return "channel";
  }
  if (/^(?:[^:]+:)?(?:group|room):/u.test(target ?? "") || migratedText(params.entry.groupId)) {
    return "group";
  }
  return "direct";
}

function migratedConversation(
  entry: MigratedConversationEntry,
  persistedChatType?: string,
  sessionKey?: string,
) {
  const canonicalDelivery = migratedObject(entry, "delivery");
  const delivery =
    migratedObject(canonicalDelivery ?? {}, "context") ?? migratedObject(entry, "deliveryContext");
  const origin =
    migratedObject(canonicalDelivery ?? {}, "origin") ?? migratedObject(entry, "origin");
  const deliveryRouteTarget = migratedText(delivery?.to);
  const kind = inferMigratedChatType({
    entry,
    persistedChatType,
    sessionKey,
    deliveryTarget: deliveryRouteTarget ?? migratedText(origin?.from),
  });
  const deliveryTarget =
    deliveryRouteTarget ?? (kind === "direct" ? migratedText(origin?.from) : undefined);
  if (!deliveryTarget) {
    return undefined;
  }
  const routeOwnsTarget = Boolean(deliveryRouteTarget);
  const channel = (
    routeOwnsTarget
      ? (migratedText(delivery?.channel) ??
        migratedText(entry.channel) ??
        migratedText(entry.lastChannel) ??
        migratedText(origin?.provider))
      : migratedText(origin?.provider)
  )?.toLowerCase();
  const accountId = normalizeAccountId(
    routeOwnsTarget
      ? (migratedText(delivery?.accountId) ??
          migratedText(entry.lastAccountId) ??
          migratedText(origin?.accountId))
      : migratedText(origin?.accountId),
  );
  const threadIdRaw = routeOwnsTarget ? delivery?.threadId : origin?.threadId;
  const threadId =
    typeof threadIdRaw === "number" && Number.isFinite(threadIdRaw)
      ? String(threadIdRaw)
      : migratedText(threadIdRaw);
  // The routable target is authoritative for both identity and delivery. Stale
  // native metadata must never label one peer while sending to another.
  const peerId = channel ? normalizeConversationPeerId(channel, deliveryTarget) : undefined;
  if (!channel || !peerId) {
    return undefined;
  }
  // Stable threaded identity hashes the routed peer plus thread id. Parent
  // refs are transient correlation hints; persisting one would diverge from
  // live ingress identity for the same thread.
  return {
    conversationRef: buildConversationRef({ channel, accountId, kind, peerId, threadId }),
    channel,
    accountId,
    kind,
    peerId,
    deliveryTarget,
    threadId,
    nativeChannelId: migratedText(origin?.nativeChannelId),
    nativeDirectUserId: migratedText(origin?.nativeDirectUserId),
    label:
      migratedText(entry.displayName) ??
      migratedText(entry.label) ??
      migratedText(entry.subject) ??
      migratedText(entry.groupId),
  };
}

/** Backfills canonical external addresses once when conversation routing becomes active. */
export function backfillSessionConversations(db: DatabaseSync): void {
  if (
    !readSqliteTableColumns(db, "session_entries") ||
    !readSqliteTableColumns(db, "sessions") ||
    !readSqliteTableColumns(db, "conversations")
  ) {
    return;
  }
  if (!readSqliteTableColumns(db, "session_conversations")) {
    db.exec(`
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'participant', 'related')),
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, conversation_id, role),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
      );
    `);
  }
  // Earlier schemas did not retain an exact delivery target. Remove their
  // derived projection, then rebuild only addresses recoverable from sessions.
  db.exec(`
    UPDATE sessions
    SET primary_conversation_id = NULL
    WHERE primary_conversation_id IN (
      SELECT conversation_id FROM conversations WHERE delivery_target = ''
    );
    DELETE FROM session_conversations
    WHERE conversation_id IN (
      SELECT conversation_id FROM conversations WHERE delivery_target = ''
    );
    DELETE FROM conversations WHERE delivery_target = '';
  `);
  const rows = db
    .prepare(
      `
        SELECT
          se.session_id,
          se.entry_json,
          se.session_key,
          se.updated_at,
          s.session_scope,
          CASE WHEN se.session_key = s.session_key THEN s.chat_type END AS persisted_chat_type
        FROM session_entries AS se
        INNER JOIN sessions AS s ON s.session_id = se.session_id
        ORDER BY se.updated_at ASC, se.session_key ASC;
      `,
    )
    .all() as Array<{
    entry_json?: unknown;
    persisted_chat_type?: unknown;
    session_key?: unknown;
    session_id?: unknown;
    session_scope?: unknown;
    updated_at?: unknown;
  }>;
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (
      conversation_id, channel, account_id, kind, peer_id, delivery_target,
      parent_conversation_id, thread_id, native_channel_id,
      native_direct_user_id, label, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel = excluded.channel,
      account_id = excluded.account_id,
      kind = excluded.kind,
      peer_id = excluded.peer_id,
      delivery_target = excluded.delivery_target,
      thread_id = excluded.thread_id,
      native_channel_id = excluded.native_channel_id,
      native_direct_user_id = excluded.native_direct_user_id,
      label = excluded.label,
      updated_at = excluded.updated_at;
  `);
  const deleteMatchingRelated = db.prepare(`
    DELETE FROM session_conversations
    WHERE session_id = ? AND conversation_id = ? AND role = 'related';
  `);
  const demotePrimary = db.prepare(`
    UPDATE session_conversations SET role = 'related', last_seen_at = ?
    WHERE session_id = ? AND role = 'primary';
  `);
  const linkConversation = db.prepare(`
    INSERT INTO session_conversations (
      session_id, conversation_id, role, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, conversation_id, role) DO UPDATE SET
      last_seen_at = excluded.last_seen_at;
  `);
  const updatePrimary = db.prepare(
    "UPDATE sessions SET primary_conversation_id = ? WHERE session_id = ?",
  );
  for (const row of rows) {
    const sessionId = migratedText(row.session_id);
    const entry = parseConversationEntry(row.entry_json);
    const updatedAt = typeof row.updated_at === "number" ? row.updated_at : Date.now();
    const conversation = entry
      ? migratedConversation(
          entry,
          migratedText(row.persisted_chat_type),
          migratedText(row.session_key),
        )
      : undefined;
    if (!sessionId || !conversation) {
      continue;
    }
    const role =
      row.session_scope === "shared-main" && conversation.kind === "direct"
        ? "participant"
        : "primary";
    upsertConversation.run(
      conversation.conversationRef,
      conversation.channel,
      conversation.accountId,
      conversation.kind,
      conversation.peerId,
      conversation.deliveryTarget,
      conversation.threadId ?? null,
      conversation.nativeChannelId ?? null,
      conversation.nativeDirectUserId ?? null,
      conversation.label ?? null,
      updatedAt,
      updatedAt,
    );
    if (role === "primary") {
      demotePrimary.run(updatedAt, sessionId);
      // The newly selected address may be the prior primary we just demoted.
      // Remove that related row before restoring its single canonical role.
      deleteMatchingRelated.run(sessionId, conversation.conversationRef);
    }
    linkConversation.run(sessionId, conversation.conversationRef, role, updatedAt, updatedAt);
    if (role === "primary") {
      updatePrimary.run(conversation.conversationRef, sessionId);
    }
  }
}

export function readSqliteTableColumns(db: DatabaseSync, tableName: string): Set<string> | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid SQLite table identifier: ${tableName}`);
  }
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!table) {
    return null;
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

/** Adds the v11 exact delivery target before the conversation backfill writes canonical rows. */
export function migrateConversationDeliveryTargetColumn(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "conversations");
  if (!columns || columns.has("delivery_target")) {
    return;
  }
  // SQLite requires a default for a NOT NULL additive column. The canonical
  // session projection replaces recoverable rows; backfill drops the rest.
  db.exec("ALTER TABLE conversations ADD COLUMN delivery_target TEXT NOT NULL DEFAULT '';");
}

export function migrateSessionEntryStatusProjection(
  db: DatabaseSync,
  readStatus: (entryJson: unknown) => string | null,
): void {
  const columns = readSqliteTableColumns(db, "session_entries");
  if (!columns) {
    return;
  }
  if (!columns.has("status")) {
    db.exec(
      "ALTER TABLE session_entries ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout'));",
    );
  }
  const rows = db.prepare("SELECT session_key, entry_json FROM session_entries").all() as Array<{
    entry_json?: unknown;
    session_key?: unknown;
  }>;
  const update = db.prepare("UPDATE session_entries SET status = ? WHERE session_key = ?");
  for (const row of rows) {
    if (typeof row.session_key === "string") {
      update.run(readStatus(row.entry_json), row.session_key);
    }
  }
}
