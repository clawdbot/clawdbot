import type { Selectable } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

type CanonicalRepairRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]> & {
  current_agent_harness_id: string | null;
  current_chat_type: string | null;
  current_ended_at: number | null;
  current_model: string | null;
  current_model_provider: string | null;
  current_previous_session_id: string | null;
  current_started_at: number | null;
  current_window_owner_session_key: string | null;
  delivery_account_id: string | null;
  delivery_channel: string | null;
  delivery_target: string | null;
  delivery_thread_id: string | null;
};

/** Doctor inventory hydrates rejected legacy blobs from promoted node/window columns. */
function hydrateCanonicalRepairEntry(row: CanonicalRepairRow): SessionEntry {
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    // Doctor owns malformed legacy repair; promoted identity columns keep the row reachable.
  }
  const createdActor = row.created_actor_type
    ? {
        type: row.created_actor_type,
        ...(row.created_actor_id ? { id: row.created_actor_id } : {}),
      }
    : undefined;
  const forkSource =
    row.fork_source_session_key && row.fork_source_session_id
      ? {
          sessionKey: row.fork_source_session_key,
          sessionId: row.fork_source_session_id,
          ...(row.fork_source_entry_id ? { entryId: row.fork_source_entry_id } : {}),
        }
      : undefined;
  const delivery =
    row.delivery_channel && row.delivery_target
      ? normalizeSessionDeliveryState({
          context: {
            channel: row.delivery_channel,
            to: row.delivery_target,
            ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
            ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
          },
        })
      : undefined;
  return projectCanonicalSessionEntryShape({
    ...record,
    ...(row.status ? { status: row.status } : {}),
    ...(row.current_started_at !== null ? { startedAt: row.current_started_at } : {}),
    ...(row.current_ended_at !== null ? { endedAt: row.current_ended_at } : {}),
    ...(row.current_chat_type ? { chatType: row.current_chat_type } : {}),
    ...(row.current_model_provider ? { modelProvider: row.current_model_provider } : {}),
    ...(row.current_model ? { model: row.current_model } : {}),
    ...(row.current_previous_session_id
      ? { previousSessionId: row.current_previous_session_id }
      : {}),
    ...(row.current_agent_harness_id ? { agentHarnessId: row.current_agent_harness_id } : {}),
    ...(delivery ? { delivery } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    ...(row.created_via ? { createdVia: row.created_via } : {}),
    ...(createdActor ? { createdActor } : {}),
    ...(row.spawned_by ? { spawnedBy: row.spawned_by } : {}),
    ...(row.parent_session_key && row.parent_session_key !== row.spawned_by
      ? { parentSessionKey: row.parent_session_key }
      : {}),
    ...(forkSource ? { forkSource } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.pinned_at !== null ? { pinnedAt: row.pinned_at } : {}),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    ...(row.last_read_at !== null ? { lastReadAt: row.last_read_at } : {}),
    ...(row.last_interaction_at !== null ? { lastInteractionAt: row.last_interaction_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    // The canonical parser rejected this blob, so duplicate or malformed identity fields are
    // untrusted. Promoted columns remain the durable transcript identity for doctor repair.
    sessionId: row.current_session_id,
    updatedAt: row.updated_at,
  });
}

export function listSqliteSessionEntriesWithCanonicalOwnerEvidence(
  scope: SessionEntryListScope = {},
): Array<SessionEntrySummary & { canonicalOwnerSessionKey?: string; rawEntryJson?: string }> {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const databaseOptions = toDatabaseOptions(resolved);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .leftJoin("session_windows as current_window", (join) =>
          join
            .onRef("current_window.session_id", "=", "session_nodes.current_session_id")
            .onRef("current_window.session_key", "=", "session_nodes.session_key"),
        )
        .leftJoin(
          "session_windows as current_window_owner",
          "current_window_owner.session_id",
          "session_nodes.current_session_id",
        )
        .leftJoin(
          "conversations as current_conversation",
          "current_conversation.conversation_id",
          "current_window.primary_conversation_id",
        )
        .selectAll("session_nodes")
        .select([
          "current_window_owner.session_key as current_window_owner_session_key",
          "current_window.started_at as current_started_at",
          "current_window.ended_at as current_ended_at",
          "current_window.chat_type as current_chat_type",
          "current_window.model_provider as current_model_provider",
          "current_window.model as current_model",
          "current_window.previous_session_id as current_previous_session_id",
          "current_window.agent_harness_id as current_agent_harness_id",
          "current_conversation.channel as delivery_channel",
          "current_conversation.account_id as delivery_account_id",
          "current_conversation.delivery_target",
          "current_conversation.thread_id as delivery_thread_id",
        ]),
    ).rows;
    const persistedEntries = new Map(
      rows.map((row) => [row.session_key, parseSessionEntryJson(row)] as const),
    );
    const validSessionKeysById = new Map<string, string[]>();
    for (const row of rows) {
      if (row.entry_valid !== 1 || !persistedEntries.get(row.session_key)) {
        continue;
      }
      const keys = validSessionKeysById.get(row.current_session_id) ?? [];
      keys.push(row.session_key);
      validSessionKeysById.set(row.current_session_id, keys);
    }
    return rows.flatMap((row) => {
      const isEmptyWindowOwner =
        row.entry_json === "{}" && row.current_window_owner_session_key === row.session_key;
      const competingValidKeys = (validSessionKeysById.get(row.current_session_id) ?? []).filter(
        (sessionKey) => sessionKey !== row.session_key,
      );
      const canonicalOwnerSessionKey = isEmptyWindowOwner
        ? competingValidKeys.length === 1
          ? competingValidKeys[0]
          : undefined
        : row.entry_json === "{}" &&
            row.current_window_owner_session_key &&
            persistedEntries.has(row.current_window_owner_session_key)
          ? row.current_window_owner_session_key
          : undefined;
      // Exact {} plus an unambiguous competing owner is corruption evidence. Without that
      // evidence, an owned empty row remains the durable retained-history tombstone.
      if (isEmptyWindowOwner && !canonicalOwnerSessionKey) {
        return [];
      }
      const persistedEntry = persistedEntries.get(row.session_key);
      const entry = persistedEntry ?? hydrateCanonicalRepairEntry(row);
      const lineageProjectionMismatch = Boolean(
        persistedEntry &&
        ((row.parent_session_key ?? undefined) !==
          (persistedEntry.parentSessionKey ?? persistedEntry.spawnedBy ?? undefined) ||
          (row.spawned_by ?? undefined) !== (persistedEntry.spawnedBy ?? undefined) ||
          (row.fork_source_session_key ?? undefined) !==
            (persistedEntry.forkSource?.sessionKey ?? undefined)),
      );
      const rawCompareRequired =
        row.entry_valid !== 1 || !persistedEntry || lineageProjectionMismatch;
      return [
        {
          sessionKey: row.session_key,
          entry,
          ...(canonicalOwnerSessionKey ? { canonicalOwnerSessionKey } : {}),
          ...(rawCompareRequired ? { rawEntryJson: row.entry_json } : {}),
        },
      ];
    });
  }, databaseOptions);
  return result.found ? result.value : [];
}
