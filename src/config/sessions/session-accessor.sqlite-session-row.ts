import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../utils/delivery-context.shared.js";
import { normalizeSessionRowChatType, normalizeText } from "./session-accessor.sqlite-normalize.js";
import { bindSessionEntryProvenance } from "./session-accessor.sqlite-provenance.js";
import { normalizeStatus } from "./session-accessor.sqlite-status.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

export function normalizeSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
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

export function bindSessionRoot(params: {
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
    reason: null,
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    ...bindSessionEntryProvenance(params.entry),
    ...bindSessionWindowEntryProjection(params),
    primary_conversation_id: null,
  };
}

export function bindSessionWindowEntryProjection(params: {
  entry: SessionEntry;
  sessionKey: string;
}) {
  return {
    previous_session_id: normalizeText(params.entry.previousSessionId),
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeStatus(params.entry.status),
    chat_type: normalizeSessionRowChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    model_provider: normalizeText(params.entry.modelProvider),
    model: normalizeText(params.entry.model),
    agent_harness_id: normalizeText(params.entry.agentHarnessId),
    parent_session_key: normalizeText(params.entry.parentSessionKey),
    spawned_by: normalizeText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

/** Project the canonical entry blob into the logical-node query columns. */
export function bindSessionNode(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const canonicalEntry = projectCanonicalSessionEntryShape(
    params.entry as unknown as Record<string, unknown>,
  );
  const actor = params.entry.createdActor;
  const legacyActorId = normalizeText(
    (params.entry as SessionEntry & { createdBy?: { id?: unknown } }).createdBy?.id,
  );
  return {
    session_key: params.sessionKey,
    current_session_id: params.entry.sessionId,
    entry_json: JSON.stringify(canonicalEntry),
    entry_valid: 1,
    updated_at: params.updatedAt,
    status: normalizeStatus(params.entry.status),
    created_at: finiteSqliteNumber(params.entry.createdAt),
    created_via: normalizeSqliteCreatedVia(params.entry.createdVia),
    created_actor_type:
      normalizeSqliteCreatedActorType(actor?.type) ?? (legacyActorId ? "human" : null),
    created_actor_id: normalizeText(actor?.id) ?? legacyActorId,
    parent_session_key:
      normalizeText(params.entry.parentSessionKey) ?? normalizeText(params.entry.spawnedBy),
    spawned_by: normalizeText(params.entry.spawnedBy),
    fork_source_session_key: normalizeText(params.entry.forkSource?.sessionKey),
    fork_source_session_id: normalizeText(params.entry.forkSource?.sessionId),
    fork_source_entry_id: normalizeText(params.entry.forkSource?.entryId),
    label: normalizeText(params.entry.label),
    display_name: normalizeText(params.entry.displayName),
    category: normalizeText(params.entry.category),
    // The retired custom-icon column remains nullable until a future schema-version migration.
    icon: null,
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
  const chatType = normalizeSessionRowChatType(entry.chatType);
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
  return normalizeText(sessionDeliveryChannel(entry));
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return normalizeText(deliveryContextFromSession(entry)?.accountId);
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeText(entry.displayName) ??
    normalizeText(entry.label) ??
    normalizeText(entry.subject) ??
    normalizeText(entry.groupId)
  );
}
