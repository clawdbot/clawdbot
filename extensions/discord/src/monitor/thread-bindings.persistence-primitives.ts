// Discord plugin module owns persisted thread-binding normalization.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import {
  isRecord,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";

export const THREAD_BINDINGS_NAMESPACE = "thread-bindings";
export const THREAD_BINDINGS_MAX_ENTRIES = 10_000;

export function normalizeTargetKind(
  raw: unknown,
  targetSessionKey: string,
): ThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") {
    return raw;
  }
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

export function normalizeThreadId(raw: unknown): string | undefined {
  return normalizeOptionalStringifiedId(raw);
}

export function toBindingRecordKey(params: { accountId: string; threadId: string }): string {
  return `${normalizeAccountId(params.accountId)}:${params.threadId.trim()}`;
}

export function normalizePersistedBinding(
  threadIdKey: string,
  raw: unknown,
): ThreadBindingRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const value = raw;
  const threadId = normalizeThreadId(value.threadId ?? threadIdKey);
  const channelId = normalizeOptionalString(value.channelId) ?? "";
  const targetSessionKey = normalizeOptionalString(value.targetSessionKey) ?? "";
  if (!threadId || !channelId || !targetSessionKey) {
    return null;
  }
  const accountId = normalizeAccountId(normalizeOptionalString(value.accountId));
  const targetKind = normalizeTargetKind(value.targetKind, targetSessionKey);
  const agentIdRaw = normalizeOptionalString(value.agentId) ?? "";
  const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
  const label = normalizeOptionalString(value.label);
  const webhookId = normalizeOptionalString(value.webhookId);
  const webhookToken = normalizeOptionalString(value.webhookToken);
  const boundBy = normalizeOptionalString(value.boundBy) ?? "system";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.floor(value.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
      ? Math.max(0, Math.floor(value.lastActivityAt))
      : boundAt;
  const idleTimeoutMs =
    typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs)
      ? Math.max(0, Math.floor(value.idleTimeoutMs))
      : undefined;
  const maxAgeMs =
    typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs)
      ? Math.max(0, Math.floor(value.maxAgeMs))
      : undefined;
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : undefined;

  const record: ThreadBindingRecord = {
    accountId,
    channelId,
    threadId,
    targetKind,
    targetSessionKey,
    agentId,
    boundBy,
    boundAt,
    lastActivityAt,
  };
  if (label !== undefined) {
    record.label = label;
  }
  if (webhookId !== undefined) {
    record.webhookId = webhookId;
  }
  if (webhookToken !== undefined) {
    record.webhookToken = webhookToken;
  }
  if (idleTimeoutMs !== undefined) {
    record.idleTimeoutMs = idleTimeoutMs;
  }
  if (maxAgeMs !== undefined) {
    record.maxAgeMs = maxAgeMs;
  }
  if (metadata !== undefined) {
    record.metadata = metadata;
  }
  return record;
}
