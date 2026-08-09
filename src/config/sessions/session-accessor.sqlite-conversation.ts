import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  conversationIdentityFromSessionEntry,
  type ConversationIdentity,
} from "./conversation-identity.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

type SessionConversationRole = "participant" | "primary" | "related";

type PreparedSessionConversation = {
  identity: ConversationIdentity;
  role: SessionConversationRole;
};

/** Shared-main DMs multiplex peers through one context; every other routed session has one primary. */
export function prepareSessionConversation(params: {
  entry: SessionEntry;
  sessionScope: string;
}): PreparedSessionConversation | null {
  const identity = conversationIdentityFromSessionEntry(params.entry);
  if (!identity) {
    return null;
  }
  return {
    identity,
    role:
      params.sessionScope === "shared-main" && identity.kind === "direct"
        ? "participant"
        : "primary",
  };
}

/** Upserts the address before the session row so its primary-conversation FK is always valid. */
export function upsertConversationIdentity(
  database: OpenClawAgentDatabase,
  identity: ConversationIdentity,
  updatedAt: number,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("conversations")
      .values({
        conversation_id: identity.conversationRef,
        channel: identity.channel,
        account_id: identity.accountId,
        kind: identity.kind,
        peer_id: identity.peerId,
        delivery_target: identity.deliveryTarget,
        parent_conversation_id: identity.parentConversationRef ?? null,
        thread_id: identity.threadId ?? null,
        native_channel_id: identity.nativeChannelId ?? null,
        native_direct_user_id: identity.nativeDirectUserId ?? null,
        label: identity.label ?? null,
        metadata_json: identity.metadata ? JSON.stringify(identity.metadata) : null,
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("conversation_id").doUpdateSet({
          channel: identity.channel,
          account_id: identity.accountId,
          kind: identity.kind,
          peer_id: identity.peerId,
          delivery_target: identity.deliveryTarget,
          parent_conversation_id: identity.parentConversationRef ?? null,
          thread_id: identity.threadId ?? null,
          native_channel_id: identity.nativeChannelId ?? null,
          native_direct_user_id: identity.nativeDirectUserId ?? null,
          label: identity.label ?? null,
          metadata_json: identity.metadata ? JSON.stringify(identity.metadata) : null,
          updated_at: updatedAt,
        }),
      ),
  );
}

/** Links one external address to its local context without conflating the two identities. */
export function linkSessionConversation(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  conversation: PreparedSessionConversation;
  updatedAt: number;
}): void {
  const { database, sessionId, conversation, updatedAt } = params;
  const db = getSessionKysely(database.db);
  if (conversation.role === "primary") {
    const stalePrimaryRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["conversation_id", "first_seen_at"])
        .where("session_id", "=", sessionId)
        .where("role", "=", "primary")
        .where("conversation_id", "!=", conversation.identity.conversationRef),
    ).rows;
    if (stalePrimaryRows.length > 0) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_conversations")
          .values(
            stalePrimaryRows.map((row) => ({
              session_id: sessionId,
              conversation_id: row.conversation_id,
              role: "related",
              first_seen_at: row.first_seen_at,
              last_seen_at: updatedAt,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
              last_seen_at: updatedAt,
            }),
          ),
      );
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("session_conversations")
          .where("session_id", "=", sessionId)
          .where("role", "=", "primary")
          .where("conversation_id", "!=", conversation.identity.conversationRef),
      );
    }
  }

  // A conversation has exactly one role within a session. Remove stale role rows
  // before inserting the current one because role participates in the table PK.
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_conversations")
      .where("session_id", "=", sessionId)
      .where("conversation_id", "=", conversation.identity.conversationRef)
      .where("role", "!=", conversation.role),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_conversations")
      .values({
        session_id: sessionId,
        conversation_id: conversation.identity.conversationRef,
        role: conversation.role,
        first_seen_at: updatedAt,
        last_seen_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
          last_seen_at: updatedAt,
        }),
      ),
  );
}
