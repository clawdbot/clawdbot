import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  conversationIdentityFromSessionEntry,
  type ConversationIdentity,
} from "./conversation-identity.js";
import {
  parseConversationRouteContext,
  refreshStoredConversationRouteContext,
  serializeStoredConversationRouteContext,
  type ConversationRouteContext,
} from "./conversation-route-context.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

type SessionConversationRole = "participant" | "primary" | "related";

type PreparedSessionConversation = {
  identity: ConversationIdentity;
  role: SessionConversationRole;
  routeContext?: ConversationRouteContext | null;
};

/** Shared-main DMs multiplex peers through one context; every other routed session has one primary. */
function prepareSessionConversation(params: {
  entry: SessionEntry;
  routeContext?: ConversationRouteContext | null;
  sessionScope: string;
}): PreparedSessionConversation | null {
  const routeContext =
    params.routeContext === null
      ? null
      : params.routeContext === undefined
        ? undefined
        : parseConversationRouteContext(params.routeContext);
  if (params.routeContext !== undefined && params.routeContext !== null && !routeContext) {
    throw new Error("Invalid conversation route context");
  }
  const identity = conversationIdentityFromSessionEntry(params.entry, routeContext);
  if (!identity) {
    return null;
  }
  return {
    identity,
    role:
      params.sessionScope === "shared-main" && identity.kind === "direct"
        ? "participant"
        : "primary",
    ...(routeContext !== undefined ? { routeContext } : {}),
  };
}

/** Keeps a previously observed route peer when a generic session writer has no route facts. */
function preserveSessionConversationIdentity(params: {
  database: OpenClawAgentDatabase;
  identity: ConversationIdentity;
  sessionIds: string[];
}): ConversationIdentity {
  if (params.sessionIds.length === 0) {
    return params.identity;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_conversations as sc")
      .innerJoin("conversations as c", "c.conversation_id", "sc.conversation_id")
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
        "c.metadata_json",
      ])
      .where("sc.session_id", "in", params.sessionIds)
      .where("c.channel", "=", params.identity.channel)
      .where("c.account_id", "=", params.identity.accountId)
      .where("c.kind", "=", params.identity.kind)
      .where("c.delivery_target", "=", params.identity.deliveryTarget)
      .where("sc.role", "in", ["primary", "participant"])
      .where("c.thread_id", params.identity.threadId ? "=" : "is", params.identity.threadId ?? null)
      .orderBy("sc.last_seen_at", "desc")
      .limit(1),
  ).rows[0];
  let metadata: Record<string, unknown> | undefined;
  if (row?.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      metadata = isRecord(parsed) ? parsed : undefined;
    } catch {
      metadata = undefined;
    }
  }
  return row
    ? {
        conversationRef: row.conversation_id,
        channel: row.channel,
        accountId: row.account_id,
        kind: params.identity.kind,
        peerId: row.peer_id,
        deliveryTarget: row.delivery_target,
        ...(row.parent_conversation_id
          ? { parentConversationRef: row.parent_conversation_id }
          : {}),
        ...(row.thread_id ? { threadId: row.thread_id } : {}),
        ...(row.native_channel_id ? { nativeChannelId: row.native_channel_id } : {}),
        ...(row.native_direct_user_id ? { nativeDirectUserId: row.native_direct_user_id } : {}),
        ...((params.identity.label ?? row.label)
          ? { label: params.identity.label ?? row.label! }
          : {}),
        ...(metadata ? { metadata } : {}),
      }
    : params.identity;
}

export function prepareSessionConversationForWrite(params: {
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  previousEntry?: SessionEntry | null;
  routeContext?: ConversationRouteContext | null;
  sessionScope: string;
}): PreparedSessionConversation | null {
  const conversation = prepareSessionConversation(params);
  if (!conversation || params.routeContext !== undefined) {
    return conversation;
  }
  conversation.identity = preserveSessionConversationIdentity({
    database: params.database,
    identity: conversation.identity,
    sessionIds: [params.entry.sessionId, params.previousEntry?.sessionId].filter(
      (sessionId): sessionId is string => Boolean(sessionId),
    ),
  });
  return conversation;
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
  previousSessionId?: string;
  sessionId: string;
  conversation: PreparedSessionConversation;
  updatedAt: number;
}): void {
  const { database, sessionId, conversation, updatedAt } = params;
  const db = getSessionKysely(database.db);
  const readAssociation = (candidateSessionId: string) =>
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["last_seen_at", "route_context_json"])
        .where("session_id", "=", candidateSessionId)
        .where("conversation_id", "=", conversation.identity.conversationRef)
        .orderBy("last_seen_at", "desc")
        .limit(1),
    ).rows[0];
  const existingAssociation =
    readAssociation(sessionId) ??
    (params.previousSessionId && params.previousSessionId !== sessionId
      ? readAssociation(params.previousSessionId)
      : undefined);
  const routeContextJson =
    conversation.routeContext === undefined
      ? existingAssociation
        ? refreshStoredConversationRouteContext(
            existingAssociation.route_context_json,
            existingAssociation.last_seen_at,
            updatedAt,
          )
        : null
      : serializeStoredConversationRouteContext(conversation.routeContext, updatedAt);
  if (conversation.role === "primary") {
    const stalePrimaryRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["conversation_id", "first_seen_at", "last_seen_at", "route_context_json"])
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
              route_context_json: refreshStoredConversationRouteContext(
                row.route_context_json,
                row.last_seen_at,
                updatedAt,
              ),
              first_seen_at: row.first_seen_at,
              last_seen_at: updatedAt,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet((eb) => ({
              route_context_json: eb.ref("excluded.route_context_json"),
              last_seen_at: updatedAt,
            })),
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
        route_context_json: routeContextJson,
        first_seen_at: updatedAt,
        last_seen_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
          route_context_json: routeContextJson,
          last_seen_at: updatedAt,
        }),
      ),
  );
}
