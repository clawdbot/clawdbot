import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ConversationIdentity, ConversationKind } from "./conversation-identity.js";
import { upsertConversationIdentity } from "./session-accessor.sqlite-conversation.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

export type ConversationRecord = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  target: string;
  parentConversationRef?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  sessionId?: string;
  sessionKey?: string;
  role?: "participant" | "primary" | "related";
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationRegistryScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

function normalizeConversationRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONVERSATION_REF_PATTERN.test(normalized)) {
    throw new Error(`Invalid conversationRef: ${value}`);
  }
  return normalized;
}

function mapConversationRow(row: {
  account_id: string;
  channel: string;
  conversation_id: string;
  conversation_created_at: number;
  conversation_updated_at: number;
  first_seen_at: number | null;
  kind: string;
  label: string | null;
  last_seen_at: number | null;
  delivery_target: string;
  native_channel_id: string | null;
  native_direct_user_id: string | null;
  parent_conversation_id: string | null;
  peer_id: string;
  role: string | null;
  current_session_id: string | null;
  current_entry_json: string | null;
  current_session_key: string | null;
  thread_id: string | null;
}): ConversationRecord | null {
  if (row.kind !== "direct" && row.kind !== "group" && row.kind !== "channel") {
    return null;
  }
  const role =
    row.role === "primary" || row.role === "participant" || row.role === "related"
      ? row.role
      : undefined;
  const currentEntry = row.current_entry_json
    ? parseSqliteSessionEntryJson({ entry_json: row.current_entry_json })
    : null;
  const hasCurrentBinding = currentEntry?.sessionId === row.current_session_id;
  return {
    conversationRef: row.conversation_id,
    channel: row.channel,
    accountId: row.account_id,
    kind: row.kind,
    target: row.delivery_target,
    ...(row.parent_conversation_id ? { parentConversationRef: row.parent_conversation_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.native_channel_id ? { nativeChannelId: row.native_channel_id } : {}),
    ...(row.native_direct_user_id ? { nativeDirectUserId: row.native_direct_user_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    // Only the current session_nodes row can bind an address. The joined
    // window row may be historical after reset, rebind, or deletion.
    ...(role && hasCurrentBinding && row.current_session_id && row.current_session_key
      ? {
          sessionId: row.current_session_id,
          sessionKey: row.current_session_key,
          role,
        }
      : {}),
    firstSeenAt: row.first_seen_at ?? row.conversation_created_at,
    lastSeenAt: row.last_seen_at ?? row.conversation_updated_at,
  };
}

function selectConversationRows(
  scope: ConversationRegistryScope,
  options: { channel?: string; conversationRef?: string; limit?: number } = {},
): ConversationRecord[] {
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("conversations as c")
    .leftJoin("session_conversations as sc", "sc.conversation_id", "c.conversation_id")
    .leftJoin("session_windows as s", "s.session_id", "sc.session_id")
    // Historical windows retain address activity, while session_nodes owns
    // the current session binding after reset/rebind.
    .leftJoin("session_nodes as sn", "sn.session_key", "s.session_key")
    .select([
      "c.conversation_id",
      "c.channel",
      "c.account_id",
      "c.kind",
      "c.peer_id",
      "c.delivery_target",
      "c.parent_conversation_id",
      "c.thread_id",
      "c.native_channel_id",
      "c.native_direct_user_id",
      "c.label",
      "c.created_at as conversation_created_at",
      "c.updated_at as conversation_updated_at",
      "sc.role",
      "sc.first_seen_at",
      "sc.last_seen_at",
      "sn.current_session_id as current_session_id",
      "sn.entry_json as current_entry_json",
      "sn.session_key as current_session_key",
    ]);
  const channel = normalizeOptionalLowercaseString(options.channel);
  if (channel) {
    query = query.where("c.channel", "=", channel);
  }
  if (options.conversationRef) {
    query = query.where(
      "c.conversation_id",
      "=",
      normalizeConversationRef(options.conversationRef),
    );
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query
      .orderBy((eb) => eb.fn.coalesce("sc.last_seen_at", "c.updated_at"), "desc")
      .orderBy("sn.updated_at", "desc"),
  ).rows;
  const unique = new Map<string, ConversationRecord>();
  for (const row of rows) {
    const mapped = mapConversationRow(row);
    if (!mapped) {
      continue;
    }
    const existing = unique.get(mapped.conversationRef);
    if (!existing) {
      unique.set(mapped.conversationRef, mapped);
      continue;
    }
    if (!existing.sessionId && mapped.sessionId && mapped.sessionKey && mapped.role) {
      // Keep the newest address activity while carrying forward the live binding
      // when a newer historical association has no current session entry.
      unique.set(mapped.conversationRef, {
        ...existing,
        sessionId: mapped.sessionId,
        sessionKey: mapped.sessionKey,
        role: mapped.role,
      });
    }
  }
  const values = [...unique.values()];
  return options.limit === undefined ? values : values.slice(0, options.limit);
}

/** Catalogs routable addresses without creating model-context sessions. */
export function registerConversationAddresses(
  scope: ConversationRegistryScope,
  identities: readonly ConversationIdentity[],
  discoveredAt = Date.now(),
): void {
  if (identities.length === 0) {
    return;
  }
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  for (const identity of identities) {
    upsertConversationIdentity(database, identity, discoveredAt);
  }
}

/** Lists stable external addresses for one agent, newest activity first. */
export function listConversations(
  scope: ConversationRegistryScope,
  options: { channel?: string; limit?: number } = {},
): ConversationRecord[] {
  return selectConversationRows(scope, options);
}

/** Resolves an opaque address to one exact channel target and its context binding, when present. */
export function resolveConversation(
  scope: ConversationRegistryScope,
  conversationRef: string,
): ConversationRecord | undefined {
  return selectConversationRows(scope, {
    conversationRef: normalizeConversationRef(conversationRef),
    limit: 1,
  })[0];
}
