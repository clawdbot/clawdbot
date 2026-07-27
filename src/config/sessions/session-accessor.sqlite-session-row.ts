import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../utils/delivery-context.shared.js";
import {
  normalizeSqliteChatType,
  normalizeSqliteText,
} from "./session-accessor.sqlite-normalize.js";
import { bindSessionEntryProvenance } from "./session-accessor.sqlite-provenance.js";
import { normalizeSqliteStatus } from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

export function normalizeSqliteSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  const raw = entry as unknown as Record<string, unknown>;
  const hasLegacyDeliveryFields = [
    "route",
    "deliveryContext",
    "origin",
    "channel",
    "lastChannel",
    "lastTo",
    "lastAccountId",
    "lastThreadId",
  ].some((key) => key in raw);
  const delivery =
    entry.delivery ?? (hasLegacyDeliveryFields ? undefined : { kind: "none" as const });
  if (typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)) {
    if (entry.delivery === delivery) {
      return entry;
    }
    return delivery ? { ...entry, delivery } : entry;
  }
  const updatedAt =
    typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)
      ? entry.sessionStartedAt
      : Date.now();
  return delivery ? { ...entry, delivery, updatedAt } : { ...entry, updatedAt };
}

export function bindSqliteSessionRoot(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const updatedAt = Number.isFinite(params.entry.updatedAt)
    ? params.entry.updatedAt
    : params.updatedAt;
  return {
    session_id: params.entry.sessionId,
    session_key: params.sessionKey,
    previous_session_id: normalizeSqliteText(params.entry.previousSessionId),
    reason: null,
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    ...bindSessionEntryProvenance(params.entry),
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeSqliteStatus(params.entry.status),
    chat_type: normalizeSqliteChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    primary_conversation_id: null,
    model_provider: normalizeSqliteText(params.entry.modelProvider),
    model: normalizeSqliteText(params.entry.model),
    agent_harness_id: normalizeSqliteText(params.entry.agentHarnessId),
    parent_session_key: normalizeSqliteText(params.entry.parentSessionKey),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

/** Project the canonical entry blob into the logical-node query columns. */
export function bindSqliteSessionNode(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const actor = params.entry.createdActor;
  const legacyActorId = normalizeSqliteText(
    (params.entry as SessionEntry & { createdBy?: { id?: unknown } }).createdBy?.id,
  );
  return {
    session_key: params.sessionKey,
    current_session_id: params.entry.sessionId,
    entry_json: JSON.stringify(params.entry),
    updated_at: params.updatedAt,
    status: normalizeSqliteStatus(params.entry.status),
    created_at: finiteSqliteNumber(params.entry.createdAt),
    created_via: normalizeSqliteCreatedVia(params.entry.createdVia),
    created_actor_type:
      normalizeSqliteCreatedActorType(actor?.type) ?? (legacyActorId ? "human" : null),
    created_actor_id: normalizeSqliteText(actor?.id) ?? legacyActorId,
    parent_session_key:
      normalizeSqliteText(params.entry.parentSessionKey) ??
      normalizeSqliteText(params.entry.spawnedBy),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    fork_source_session_key: normalizeSqliteText(params.entry.forkSource?.sessionKey),
    fork_source_session_id: normalizeSqliteText(params.entry.forkSource?.sessionId),
    fork_source_entry_id: normalizeSqliteText(params.entry.forkSource?.entryId),
    label: normalizeSqliteText(params.entry.label),
    display_name: normalizeSqliteText(params.entry.displayName),
    category: normalizeSqliteText(params.entry.category),
    icon: normalizeSqliteText(params.entry.icon),
    pinned_at: finiteSqliteNumber(params.entry.pinnedAt),
    archived_at: finiteSqliteNumber(params.entry.archivedAt),
    last_read_at: finiteSqliteNumber(params.entry.lastReadAt),
    last_interaction_at: finiteSqliteNumber(params.entry.lastInteractionAt),
    last_activity_at: finiteSqliteNumber(params.entry.lastActivityAt),
  };
}

function normalizeSqliteCreatedVia(value: SessionEntry["createdVia"]) {
  return value === "operator" ||
    value === "spawn" ||
    value === "channel" ||
    value === "cron" ||
    value === "talk" ||
    value === "run" ||
    value === "plugin" ||
    value === "internal"
    ? value
    : null;
}

function normalizeSqliteCreatedActorType(value: unknown) {
  return value === "human" || value === "agent" || value === "system" ? value : null;
}

function resolveSqliteSessionScope(
  entry: Pick<SessionEntry, "chatType">,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSqliteChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSqliteSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function finiteSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveSqliteSessionChannel(entry: SessionEntry): string | null {
  return normalizeSqliteText(sessionDeliveryChannel(entry));
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return normalizeSqliteText(deliveryContextFromSession(entry)?.accountId);
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.displayName) ??
    normalizeSqliteText(entry.label) ??
    normalizeSqliteText(entry.subject) ??
    normalizeSqliteText(entry.groupId)
  );
}
