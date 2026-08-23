import { createHash } from "node:crypto";
import type { Selectable } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { projectSqliteSessionOwner } from "./session-accessor.sqlite-owner-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { scanCanonicalSqliteSessionEntries } from "./session-canonical-key.js";
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

type CanonicalSessionDecision = {
  canonicalOwnerSessionKey?: string;
  delivery?: SessionEntry["delivery"];
  forkSourceSessionKey?: string;
  groupId?: string;
  parentSessionKey?: string;
  rawCompareRequired: boolean;
  sessionKey: string;
  spawnedBy?: string;
};

export type CanonicalSessionRepairFact = CanonicalSessionDecision & {
  decisionToken: string;
  inventoryToken: string;
};

type ScannedCanonicalSessionFact = {
  currentSessionId: string;
  currentWindowOwnerSessionKey: string | null;
  decision: Omit<CanonicalSessionDecision, "canonicalOwnerSessionKey">;
  entryJsonIsEmpty: boolean;
  rowToken: string;
};

export type DoctorSessionScanScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
};

type DoctorSessionEntrySummary = SessionEntrySummary & {
  recoveredFromProjections: boolean;
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
  const entry = projectCanonicalSessionEntryShape({
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
    ...(row.icon ? { icon: row.icon } : {}),
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
  return projectSqliteSessionOwner(entry, row);
}

function canonicalRepairQuery(database: Pick<OpenClawAgentDatabase, "db">) {
  const db = getSessionKysely(database.db);
  return db
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
    ])
    .orderBy("session_nodes.session_key");
}

function scanCanonicalSessionFactsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  selectedKeys?: ReadonlySet<string>,
): {
  facts: CanonicalSessionRepairFact[];
  inventoryToken: string;
  loaded: Map<string, { entry: SessionEntry; rawEntryJson: string }>;
} {
  const scanned: ScannedCanonicalSessionFact[] = [];
  const loaded = new Map<string, { entry: SessionEntry; rawEntryJson: string }>();
  const validSessionKeysById = new Map<string, string[]>();
  const inventoriedSessionKeys = new Set<string>();
  for (const row of iterateSqliteQuerySync(database.db, canonicalRepairQuery(database))) {
    inventoriedSessionKeys.add(row.session_key);
    const persistedEntry = parseSessionEntryJson(row);
    if (row.entry_valid === 1 && persistedEntry) {
      const keys = validSessionKeysById.get(row.current_session_id) ?? [];
      keys.push(row.session_key);
      validSessionKeysById.set(row.current_session_id, keys);
    }
    const entry = persistedEntry ?? hydrateCanonicalRepairEntry(row);
    if (selectedKeys?.has(row.session_key)) {
      loaded.set(row.session_key, { entry, rawEntryJson: row.entry_json });
    }
    const lineageProjectionMismatch = Boolean(
      persistedEntry &&
      ((row.parent_session_key ?? undefined) !==
        (persistedEntry.parentSessionKey ?? persistedEntry.spawnedBy ?? undefined) ||
        (row.spawned_by ?? undefined) !== (persistedEntry.spawnedBy ?? undefined) ||
        (row.fork_source_session_key ?? undefined) !==
          (persistedEntry.forkSource?.sessionKey ?? undefined)),
    );
    const decision = {
      delivery: entry.delivery,
      forkSourceSessionKey: entry.forkSource?.sessionKey,
      groupId: entry.groupId,
      parentSessionKey: entry.parentSessionKey,
      rawCompareRequired: row.entry_valid !== 1 || !persistedEntry || lineageProjectionMismatch,
      sessionKey: row.session_key,
      spawnedBy: entry.spawnedBy,
    };
    const context = deliveryContextFromSession(decision);
    const origin = sessionDeliveryOrigin(decision);
    scanned.push({
      currentSessionId: row.current_session_id,
      currentWindowOwnerSessionKey: row.current_window_owner_session_key,
      decision,
      entryJsonIsEmpty: row.entry_json === "{}",
      rowToken: JSON.stringify([
        row.session_key,
        row.current_session_id,
        row.entry_valid,
        persistedEntry !== null,
        row.entry_json === "{}",
        row.current_window_owner_session_key,
        context?.channel ?? null,
        context?.to ?? null,
        context?.threadId == null ? null : String(context.threadId),
        origin?.nativeChannelId ?? null,
        origin?.to ?? null,
        decision.groupId ?? null,
        decision.parentSessionKey ?? null,
        decision.spawnedBy ?? null,
        decision.forkSourceSessionKey ?? null,
        row.parent_session_key,
        row.spawned_by,
        row.fork_source_session_key,
        decision.rawCompareRequired,
      ]),
    });
  }
  const inventoryHash = createHash("sha256");
  const facts: Array<Omit<CanonicalSessionRepairFact, "inventoryToken">> = [];
  for (const fact of scanned) {
    const isEmptyWindowOwner =
      fact.entryJsonIsEmpty && fact.currentWindowOwnerSessionKey === fact.decision.sessionKey;
    const competingValidKeys = (validSessionKeysById.get(fact.currentSessionId) ?? [])
      .filter((sessionKey) => sessionKey !== fact.decision.sessionKey)
      .toSorted();
    const canonicalOwnerSessionKey = isEmptyWindowOwner
      ? competingValidKeys.length === 1
        ? competingValidKeys[0]
        : undefined
      : fact.entryJsonIsEmpty &&
          fact.currentWindowOwnerSessionKey &&
          inventoriedSessionKeys.has(fact.currentWindowOwnerSessionKey)
        ? fact.currentWindowOwnerSessionKey
        : undefined;
    const decisionToken = JSON.stringify([fact.rowToken, canonicalOwnerSessionKey ?? null]);
    inventoryHash.update(decisionToken).update("\0");
    if (!isEmptyWindowOwner || canonicalOwnerSessionKey) {
      facts.push({
        ...fact.decision,
        ...(canonicalOwnerSessionKey ? { canonicalOwnerSessionKey } : {}),
        decisionToken,
      });
    }
  }
  const inventoryToken = inventoryHash.digest("base64url");
  return {
    facts: facts.map((fact) => Object.assign(fact, { inventoryToken })),
    inventoryToken,
    loaded,
  };
}

function loadCanonicalRepairEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  facts: readonly CanonicalSessionRepairFact[],
): Array<SessionEntrySummary & { rawEntryJson?: string }> {
  const current = scanCanonicalSessionFactsFromDatabase(
    database,
    new Set(facts.map((fact) => fact.sessionKey)),
  );
  const currentByKey = new Map(current.facts.map((fact) => [fact.sessionKey, fact]));
  const expectedInventoryTokens = new Set(facts.map((fact) => fact.inventoryToken));
  if (expectedInventoryTokens.size !== 1 || !expectedInventoryTokens.has(current.inventoryToken)) {
    throw new Error("Canonical session repair inputs changed during scan; retry Doctor");
  }
  return facts.map((fact) => {
    if (currentByKey.get(fact.sessionKey)?.decisionToken !== fact.decisionToken) {
      throw new Error(
        `Canonical session repair inputs changed during scan for ${fact.sessionKey}; retry Doctor`,
      );
    }
    const loaded = current.loaded.get(fact.sessionKey);
    if (!loaded) {
      throw new Error(`Canonical session repair row disappeared during scan: ${fact.sessionKey}`);
    }
    return {
      entry: loaded.entry,
      sessionKey: fact.sessionKey,
      ...(fact.rawCompareRequired ? { rawEntryJson: loaded.rawEntryJson } : {}),
    };
  });
}

export function listCanonicalSessionRepairFacts(
  scope: DoctorSessionScanScope,
): CanonicalSessionRepairFact[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => scanCanonicalSessionFactsFromDatabase(database).facts,
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

export function loadCanonicalSessionRepairEntries(
  scope: DoctorSessionScanScope,
  facts: readonly CanonicalSessionRepairFact[],
): Array<SessionEntrySummary & { rawEntryJson?: string }> {
  if (facts.length === 0) {
    return [];
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => loadCanonicalRepairEntriesFromDatabase(database, facts),
    toDatabaseOptions(resolved),
  );
  if (!result.found) {
    throw new Error("Canonical session repair database disappeared during scan; retry Doctor");
  }
  return result.value;
}

/** Strict Doctor scan of canonical rows, ordered by durable session key. */
export function scanDoctorSessionEntriesStrict(
  scope: DoctorSessionScanScope,
  visit: (summary: DoctorSessionEntrySummary) => void,
): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    let count = 0;
    scanCanonicalSqliteSessionEntries(database, ({ entry, sessionKey }) => {
      if (isInternalSessionEffectsKey(sessionKey)) {
        return;
      }
      visit({ entry, recoveredFromProjections: false, sessionKey });
      count += 1;
    });
    return count;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}

/** Tolerant Doctor preview scan with canonical-repair tombstone eligibility. */
export function scanDoctorSessionEntriesTolerant(
  scope: DoctorSessionScanScope,
  visit: (summary: DoctorSessionEntrySummary) => void,
): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const eligible = new Set(
      scanCanonicalSessionFactsFromDatabase(database).facts.map((fact) => fact.sessionKey),
    );
    let count = 0;
    for (const row of iterateSqliteQuerySync(database.db, canonicalRepairQuery(database))) {
      if (!eligible.has(row.session_key) || isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(row);
      visit({
        entry: entry ?? hydrateCanonicalRepairEntry(row),
        recoveredFromProjections: entry === null,
        sessionKey: row.session_key,
      });
      count += 1;
    }
    return count;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}
