/** Doctor repair for Telegram General-topic conversation identities written before #113063. */
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";

const GENERAL_TOPIC_ID = "1";
const LEGACY_GENERAL_TARGET = /^telegram:(-?\d+):topic:1$/u;

type ConversationRow = {
  account_id: string;
  channel: string;
  conversation_id: string;
  created_at: number;
  delivery_target: string;
  kind: string;
  label: string | null;
  metadata_json: string | null;
  native_channel_id: string | null;
  native_direct_user_id: string | null;
  parent_conversation_id: string | null;
  peer_id: string;
  thread_id: string | null;
  updated_at: number;
};

type TelegramGeneralTopicConversationRepair = {
  agentId: string;
  canonicalConversationId: string;
  legacyConversationId: string;
  storePath: string;
};

function canonicalIdentity(row: ConversationRow) {
  const targetMatch = LEGACY_GENERAL_TARGET.exec(row.delivery_target);
  if (
    row.channel !== "telegram" ||
    row.kind !== "group" ||
    row.thread_id !== GENERAL_TOPIC_ID ||
    row.parent_conversation_id !== null ||
    !targetMatch ||
    row.peer_id !== `${targetMatch[1]}:topic:${GENERAL_TOPIC_ID}`
  ) {
    return null;
  }
  const peerId = targetMatch[1]!;
  return {
    conversationId: buildConversationRef({
      channel: row.channel,
      accountId: row.account_id,
      kind: "group",
      peerId,
      threadId: GENERAL_TOPIC_ID,
    }),
    deliveryTarget: `telegram:${peerId}`,
    peerId,
  };
}

function listLegacyRows(database: import("node:sqlite").DatabaseSync): ConversationRow[] {
  const db = getSessionKysely(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("conversations")
      .selectAll()
      .where("channel", "=", "telegram")
      .where("kind", "=", "group")
      .where("thread_id", "=", GENERAL_TOPIC_ID)
      .where("parent_conversation_id", "is", null),
  ).rows.filter((row) => canonicalIdentity(row) !== null);
}

function resolveRepairScopes(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return resolveAllAgentSessionStoreTargetsSync(cfg, { env }).map((target) => {
    const scope = resolveSqliteReadScope({
      agentId: target.agentId,
      env,
      storePath: target.storePath,
    });
    return { scope, storePath: target.storePath };
  });
}

/** Finds stale General-topic rows without creating or migrating agent databases. */
export function detectTelegramGeneralTopicConversationRepairs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TelegramGeneralTopicConversationRepair[] {
  const env = params.env ?? process.env;
  return resolveRepairScopes(params.cfg, env).flatMap(({ scope, storePath }) => {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        listLegacyRows(database.db).flatMap((row) => {
          const canonical = canonicalIdentity(row);
          return canonical && canonical.conversationId !== row.conversation_id
            ? [
                {
                  agentId: scope.agentId,
                  canonicalConversationId: canonical.conversationId,
                  legacyConversationId: row.conversation_id,
                  storePath,
                },
              ]
            : [];
        }),
      toDatabaseOptions(scope),
    );
    return result.found ? result.value : [];
  });
}

const roleRank = { related: 0, participant: 1, primary: 2 } as const;

function canonicalizeLegacySessionEntry(
  entry: SessionEntry,
  legacyTarget: string,
  canonicalTarget: string,
): SessionEntry | null {
  const delivery = entry.delivery;
  if (
    delivery?.kind !== "external" ||
    delivery.context.channel !== "telegram" ||
    String(delivery.context.threadId) !== GENERAL_TOPIC_ID ||
    delivery.context.to !== legacyTarget
  ) {
    return null;
  }
  return {
    ...entry,
    delivery: {
      ...delivery,
      context: { ...delivery.context, to: canonicalTarget },
      route: {
        ...delivery.route,
        target: {
          ...delivery.route.target,
          to: canonicalTarget,
          ...(delivery.route.target?.rawTo === legacyTarget ? { rawTo: canonicalTarget } : {}),
        },
      },
      origin:
        delivery.origin.to === legacyTarget
          ? { ...delivery.origin, to: canonicalTarget }
          : delivery.origin,
    },
  };
}

function repairLegacyRow(database: OpenClawAgentDatabase, legacyConversationId: string): boolean {
  const db = getSessionKysely(database.db);
  const legacy = executeSqliteQuerySync(
    database.db,
    db.selectFrom("conversations").selectAll().where("conversation_id", "=", legacyConversationId),
  ).rows[0];
  const canonical = legacy ? canonicalIdentity(legacy) : null;
  if (!legacy || !canonical || canonical.conversationId === legacy.conversation_id) {
    return false;
  }
  const existing = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("conversations")
      .selectAll()
      .where("conversation_id", "=", canonical.conversationId),
  ).rows[0];
  if (
    existing &&
    (existing.channel !== "telegram" ||
      existing.account_id !== legacy.account_id ||
      existing.kind !== "group" ||
      existing.peer_id !== canonical.peerId ||
      existing.thread_id !== GENERAL_TOPIC_ID ||
      existing.parent_conversation_id !== null)
  ) {
    throw new Error(`canonical Telegram conversation id collision: ${canonical.conversationId}`);
  }

  const merged = existing ?? legacy;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("conversations")
      .values({
        ...merged,
        conversation_id: canonical.conversationId,
        peer_id: canonical.peerId,
        delivery_target: canonical.deliveryTarget,
        created_at: Math.min(existing?.created_at ?? legacy.created_at, legacy.created_at),
        updated_at: Math.max(existing?.updated_at ?? legacy.updated_at, legacy.updated_at),
        native_channel_id: existing?.native_channel_id ?? legacy.native_channel_id,
        native_direct_user_id: existing?.native_direct_user_id ?? legacy.native_direct_user_id,
        label: existing?.label ?? legacy.label,
        metadata_json: existing?.metadata_json ?? legacy.metadata_json,
      })
      .onConflict((conflict) =>
        conflict.column("conversation_id").doUpdateSet({
          created_at: Math.min(existing?.created_at ?? legacy.created_at, legacy.created_at),
          updated_at: Math.max(existing?.updated_at ?? legacy.updated_at, legacy.updated_at),
          native_channel_id: existing?.native_channel_id ?? legacy.native_channel_id,
          native_direct_user_id: existing?.native_direct_user_id ?? legacy.native_direct_user_id,
          label: existing?.label ?? legacy.label,
          metadata_json: existing?.metadata_json ?? legacy.metadata_json,
        }),
      ),
  );

  const boundWindows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_conversations as sc")
      .innerJoin("session_windows as sw", "sw.session_id", "sc.session_id")
      .select(["sw.session_id", "sw.session_key"])
      .where("sc.conversation_id", "=", legacy.conversation_id),
  ).rows;
  for (const window of boundWindows) {
    const current = readExactSessionEntryRow(database, window.session_key);
    if (!current || current.entry.sessionId !== window.session_id) {
      continue;
    }
    const normalized = canonicalizeLegacySessionEntry(
      current.entry,
      legacy.delivery_target,
      canonical.deliveryTarget,
    );
    if (normalized) {
      writeSessionEntry(database, window.session_key, normalized, { previousEntry: current.entry });
    }
  }

  const conversationIds = [legacy.conversation_id, canonical.conversationId];
  const bindings = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_conversations")
      .selectAll()
      .where("conversation_id", "in", conversationIds),
  ).rows;
  const mergedBindings = new Map<string, (typeof bindings)[number]>();
  for (const binding of bindings) {
    const current = mergedBindings.get(binding.session_id);
    const currentRank = roleRank[current?.role as keyof typeof roleRank] ?? -1;
    const nextRank = roleRank[binding.role as keyof typeof roleRank] ?? -1;
    const selected = nextRank > currentRank ? binding : (current ?? binding);
    mergedBindings.set(binding.session_id, {
      ...selected,
      conversation_id: canonical.conversationId,
      first_seen_at: Math.min(
        current?.first_seen_at ?? binding.first_seen_at,
        binding.first_seen_at,
      ),
      last_seen_at: Math.max(current?.last_seen_at ?? binding.last_seen_at, binding.last_seen_at),
    });
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_conversations").where("conversation_id", "in", conversationIds),
  );
  if (mergedBindings.size > 0) {
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_conversations").values([...mergedBindings.values()]),
    );
  }
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ primary_conversation_id: canonical.conversationId })
      .where("primary_conversation_id", "=", legacy.conversation_id),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("conversation_deliveries")
      .set({ conversation_id: canonical.conversationId })
      .where("conversation_id", "=", legacy.conversation_id),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("conversations")
      .set({ parent_conversation_id: canonical.conversationId })
      .where("parent_conversation_id", "=", legacy.conversation_id),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("conversations").where("conversation_id", "=", legacy.conversation_id),
  );
  return true;
}

/** Canonicalizes stale rows and merges every durable reference in one transaction per agent DB. */
export async function repairTelegramGeneralTopicConversations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = params.env ?? process.env;
  let repaired = 0;
  for (const { scope } of resolveRepairScopes(params.cfg, env)) {
    await runExclusiveSqliteSessionWrite(scope, async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
      repaired += runSqliteImmediateTransactionSync(
        database.db,
        () => {
          // Detection is advisory. Re-read every candidate after BEGIN so a live
          // session write cannot turn the doctor repair into a stale merge.
          let databaseRepairs = 0;
          for (const row of listLegacyRows(database.db)) {
            if (repairLegacyRow(database, row.conversation_id)) {
              databaseRepairs += 1;
            }
          }
          return databaseRepairs;
        },
        { databaseLabel: database.path, operationLabel: "doctor-telegram-general-topic" },
      );
    });
  }
  return repaired;
}
