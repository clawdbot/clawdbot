// Store entry shape normalization rejects unsafe persisted metadata before runtime use.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { validateSessionId } from "./paths.js";
import type { PendingTranscriptRepairState, SessionEntry } from "./types.js";

function normalizeSessionEntryArchiveReason(
  value: unknown,
): SessionEntry["archiveReason"] | undefined {
  return value === "manual" ||
    value === "active-session-cap" ||
    value === "age-retention" ||
    value === "stale-dashboard" ||
    value === "restart-recovery"
    ? value
    : undefined;
}

// Persisted stores may contain old or malformed ids; reject path-like ids before use.
function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255 || trimmed !== trimmed.normalize("NFC")) {
    return false;
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return false;
  }
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._:@-]*$/u.test(trimmed);
}

function normalizeTranscriptSessionId(value: string): string | undefined {
  try {
    return validateSessionId(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
}

/** Removes retired runtime locator fields before a session entry is persisted or returned. */
export function projectCanonicalSessionEntryShape(value: Record<string, unknown>): SessionEntry {
  const {
    sessionFile: _retiredSessionFile,
    transcriptPath: _retiredTranscriptPath,
    pendingFinalDeliveryCreatedAt,
    pendingFinalDeliveryLastAttemptAt: _pendingFinalDeliveryLastAttemptAt,
    pendingFinalDeliveryAttemptCount: _pendingFinalDeliveryAttemptCount,
    pendingFinalDeliveryLastError: _pendingFinalDeliveryLastError,
    pendingFinalDeliveryText,
    pendingFinalDeliveryContext,
    pendingFinalDeliveryIntentId,
    fallbackNoticeSelectedModel,
    fallbackNoticeActiveModel,
    fallbackNoticeReason,
    memoryFlushAt: _memoryFlushAt,
    memoryFlushCompactionCount,
    memoryFlushContextHash: _memoryFlushContextHash,
    memoryFlushFailureCount,
    memoryFlushLastFailedAt: _memoryFlushLastFailedAt,
    memoryFlushLastFailureError: _memoryFlushLastFailureError,
    owner: _projectedOwner,
    participants: _projectedParticipants,
    participantCount: _projectedParticipantCount,
    ...canonicalValue
  } = value;
  const icon =
    typeof canonicalValue.icon === "string" ? normalizeSessionIconValue(canonicalValue.icon) : null;
  if (icon) {
    canonicalValue.icon = icon;
  } else {
    delete canonicalValue.icon;
  }
  const color =
    typeof canonicalValue.color === "string"
      ? normalizeSessionColorValue(canonicalValue.color)
      : null;
  if (color) {
    canonicalValue.color = color;
  } else {
    delete canonicalValue.color;
  }
  const legacyPendingText = normalizeOptionalString(pendingFinalDeliveryText);
  const legacySelectedModel = normalizeOptionalString(fallbackNoticeSelectedModel);
  const legacyActiveModel = normalizeOptionalString(fallbackNoticeActiveModel);
  const legacyFlushCompactionCount = normalizeCount(memoryFlushCompactionCount);
  const legacyFlushFailureCount = normalizeCount(memoryFlushFailureCount);
  const intentId = normalizeOptionalString(pendingFinalDeliveryIntentId);
  const pendingFinalDelivery =
    normalizePendingFinalDelivery(canonicalValue.pendingFinalDelivery) ??
    (legacyPendingText || value.pendingFinalDelivery === true
      ? {
          ...(legacyPendingText
            ? { kind: "replayable" as const, text: legacyPendingText }
            : { kind: "transport-only" as const }),
          createdAt:
            normalizeOptionalTimestamp(pendingFinalDeliveryCreatedAt) ??
            normalizeOptionalTimestamp(value.updatedAt) ??
            0,
          ...(isRecord(pendingFinalDeliveryContext)
            ? { context: pendingFinalDeliveryContext }
            : {}),
          ...(intentId ? { intentId } : {}),
        }
      : undefined);
  if (pendingFinalDelivery) {
    canonicalValue.pendingFinalDelivery = pendingFinalDelivery;
  } else {
    delete canonicalValue.pendingFinalDelivery;
  }
  const pendingDeliveryNotice = normalizePendingDeliveryNotice(
    canonicalValue.pendingDeliveryNotice,
  );
  if (pendingDeliveryNotice) {
    canonicalValue.pendingDeliveryNotice = pendingDeliveryNotice;
  } else {
    delete canonicalValue.pendingDeliveryNotice;
  }
  const pendingTranscriptRepair = normalizePendingTranscriptRepair(
    canonicalValue.pendingTranscriptRepair,
  );
  if (pendingTranscriptRepair) {
    canonicalValue.pendingTranscriptRepair = pendingTranscriptRepair;
  } else {
    delete canonicalValue.pendingTranscriptRepair;
  }
  const reason = normalizeOptionalString(fallbackNoticeReason);
  const fallbackNotice =
    normalizeFallbackNotice(canonicalValue.fallbackNotice) ??
    (legacySelectedModel && legacyActiveModel
      ? {
          kind: "active" as const,
          selectedModel: legacySelectedModel,
          activeModel: legacyActiveModel,
          ...(reason ? { reason } : {}),
        }
      : undefined);
  if (fallbackNotice) {
    canonicalValue.fallbackNotice = fallbackNotice;
  } else {
    delete canonicalValue.fallbackNotice;
  }
  const memoryFlush =
    normalizeMemoryFlush(canonicalValue.memoryFlush) ??
    (legacyFlushFailureCount && legacyFlushFailureCount > 0
      ? {
          kind: "failed" as const,
          ...(legacyFlushCompactionCount !== undefined
            ? { compactionCount: legacyFlushCompactionCount }
            : {}),
          failureCount: legacyFlushFailureCount,
        }
      : legacyFlushCompactionCount !== undefined
        ? { kind: "succeeded" as const, compactionCount: legacyFlushCompactionCount }
        : undefined);
  if (memoryFlush) {
    canonicalValue.memoryFlush = memoryFlush;
  } else {
    delete canonicalValue.memoryFlush;
  }
  const archiveReason = normalizeSessionEntryArchiveReason(canonicalValue.archiveReason);
  if (canonicalValue.archivedAt !== undefined) {
    if (archiveReason) {
      canonicalValue.archiveReason = archiveReason;
    } else {
      delete canonicalValue.archiveReason;
    }
  } else {
    delete canonicalValue.archivedBy;
    delete canonicalValue.archiveReason;
  }
  return canonicalValue as unknown as SessionEntry;
}

/** Removes the runtime-only skill catalog without mutating the live session snapshot. */
export function stripRuntimeOnlySessionSkillsFields(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (snapshot?.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...skillsSnapshot } = snapshot;
  return { ...entry, skillsSnapshot };
}

function normalizePendingFinalDelivery(
  value: unknown,
): SessionEntry["pendingFinalDelivery"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (createdAt === undefined) {
    return undefined;
  }
  const intentId = normalizeOptionalString(value.intentId);
  const deliveries = normalizePendingFinalDeliveries(value.deliveries);
  const base = {
    createdAt,
    ...(isRecord(value.context) ? { context: value.context } : {}),
    ...(intentId ? { intentId } : {}),
    ...(deliveries ? { deliveries } : {}),
  };
  if (value.kind === "transport-only") {
    return { kind: "transport-only", ...base };
  }
  const text = normalizeOptionalString(value.text);
  return value.kind === "replayable" && text ? { kind: "replayable", text, ...base } : undefined;
}

function normalizePendingFinalDeliveries(
  value: unknown,
): NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deliveries: NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> =
    value.flatMap((item) => {
      const id = isRecord(item) ? normalizeOptionalString(item.id) : undefined;
      const state = isRecord(item) ? item.state : undefined;
      return id &&
        (state === "prepared" ||
          state === "queued" ||
          state === "delivered" ||
          state === "suppressed" ||
          state === "unknown")
        ? [{ id, state }]
        : [];
    });
  return deliveries.length > 0 ? deliveries : undefined;
}

function normalizePendingDeliveryNotice(
  value: unknown,
): SessionEntry["pendingDeliveryNotice"] | undefined {
  if (!isRecord(value) || !isRecord(value.context)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  const intentId = normalizeOptionalString(value.intentId);
  return createdAt !== undefined &&
    intentId &&
    (value.state === "owed" || value.state === "unresolved" || value.state === "acknowledged")
    ? { createdAt, context: value.context, intentId, state: value.state }
    : undefined;
}

function normalizePendingTranscriptRepair(
  value: unknown,
): SessionEntry["pendingTranscriptRepair"] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const normalized: NonNullable<SessionEntry["pendingTranscriptRepair"]> = [];
  for (const item of value) {
    const record = normalizePendingTranscriptRepairRecord(item);
    if (record) {
      normalized.push(record);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePendingTranscriptRepairRecord(
  value: unknown,
): PendingTranscriptRepairState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  const text = normalizeOptionalString(value.text);
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (!id || !text || createdAt === undefined) {
    return undefined;
  }
  const provider = normalizeOptionalString(value.provider);
  const model = normalizeOptionalString(value.model);
  return {
    id,
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    createdAt,
  };
}

function normalizeFallbackNotice(value: unknown): SessionEntry["fallbackNotice"] | undefined {
  if (!isRecord(value) || value.kind !== "active") {
    return undefined;
  }
  const selectedModel = normalizeOptionalString(value.selectedModel);
  const activeModel = normalizeOptionalString(value.activeModel);
  const reason = normalizeOptionalString(value.reason);
  return selectedModel && activeModel
    ? { kind: "active", selectedModel, activeModel, ...(reason ? { reason } : {}) }
    : undefined;
}

function normalizeMemoryFlush(value: unknown): SessionEntry["memoryFlush"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compactionCount = normalizeCount(value.compactionCount);
  if (value.kind === "succeeded" && compactionCount !== undefined) {
    return { kind: "succeeded", compactionCount };
  }
  const failureCount = normalizeCount(value.failureCount);
  if (value.kind !== "failed" || !failureCount) {
    return undefined;
  }
  return {
    kind: "failed",
    ...(compactionCount !== undefined ? { compactionCount } : {}),
    failureCount,
  };
}

function normalizeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Normalizes persisted session store entries before they reach runtime callers. */
export function normalizePersistedSessionEntryShape(
  value: unknown,
  options: { sessionKey?: string } = {},
): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelSelectionLocked = value.modelSelectionLocked === true;
  let next = projectCanonicalSessionEntryShape(value);
  if (value.sessionId !== undefined) {
    if (!isSafeSessionId(value.sessionId)) {
      return undefined;
    }
    const sessionId = value.sessionId.trim();
    const legacySessionFile = value.sessionFile;
    const pendingLegacyKeyId =
      !modelSelectionLocked &&
      options.sessionKey !== undefined &&
      parseAgentSessionKey(options.sessionKey) !== null &&
      sessionId === options.sessionKey &&
      (value.initializationPending === true ||
        typeof legacySessionFile !== "string" ||
        !legacySessionFile.trim());
    if (pendingLegacyKeyId) {
      const { sessionId: _legacyPendingSessionId, ...pendingEntry } = next;
      next = { ...pendingEntry, initializationPending: true } as SessionEntry;
    } else {
      if (modelSelectionLocked && sessionId !== value.sessionId) {
        // A harness lock protects the exact durable identity. Repairing it here
        // would make a corrupted row look valid before ownership validation.
        return undefined;
      }
      const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
      if (!transcriptSessionId) {
        return undefined;
      }
      if (sessionId !== value.sessionId) {
        next = { ...next, sessionId };
      }
    }
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}
