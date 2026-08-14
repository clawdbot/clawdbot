// Owns versioned failed-row policy parsing and compact tombstone projection.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
  DeliveryQueueTerminalFence,
  DeliveryQueueTerminalPolicy,
  DeliveryQueueTerminalReason,
} from "./delivery-queue-sqlite.types.js";

export const FAILED_TERMINAL_RECOVERY_STATE = "failed_terminal_v1";
export const DELIVERY_FAILURE_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DELIVERY_FAILURE_DETAIL_MAX_ENTRIES = 20_000;
export const SUBAGENT_COMPLETION_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;

type LegacySessionTerminalPolicyClassification =
  | {
      classified: true;
      mode: "safe" | "owner-managed";
      policy: DeliveryQueueTerminalPolicy;
      entry: DeliveryQueueEntryState;
    }
  | {
      classified: false;
      reason: "ambiguous" | "compacted" | "fenced" | "legacy_unknown";
    };

type SessionFailureReplayClassification =
  | {
      ok: true;
      source: "canonical" | "legacy";
      policy: DeliveryQueueTerminalPolicy;
      entry: DeliveryQueueEntryState;
    }
  | {
      ok: false;
      reason: "ambiguous" | "compacted" | "owner_managed" | "fenced" | "legacy_unknown";
    };

const REASONS = new Set<DeliveryQueueTerminalReason>([
  "admission_rejected",
  "legacy_unknown",
  "owner_dismissed",
  "owner_expired",
  "owner_settled",
  "permanent_rejection",
  "retry_exhausted",
]);
const EVIDENCE = new Set<NonNullable<DeliveryQueueTerminalPolicy["evidence"]>>([
  "delivery_started",
  "legacy_unknown",
  "owner_managed",
  "pre_side_effect",
  "send_attempt_started",
  "settled",
  "unknown_after_send",
]);

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseFence(value: unknown): DeliveryQueueTerminalFence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fence = value as Record<string, unknown>;
  if (fence.kind === "none" || fence.kind === "permanent") {
    return { kind: fence.kind };
  }
  if (
    fence.kind === "producer-bounded" &&
    typeof fence.idPrefix === "string" &&
    fence.idPrefix.length > 0 &&
    isPositiveSafeInteger(fence.maxAgeMs) &&
    isPositiveSafeInteger(fence.maxEntries)
  ) {
    return {
      kind: fence.kind,
      idPrefix: fence.idPrefix,
      maxAgeMs: fence.maxAgeMs,
      maxEntries: fence.maxEntries,
    };
  }
  return undefined;
}

export function parseDeliveryQueueTerminalPolicy(
  value: unknown,
): DeliveryQueueTerminalPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const policy = value as Record<string, unknown>;
  const fence = parseFence(policy.fence);
  if (
    policy.version !== 1 ||
    (policy.detail !== "full" && policy.detail !== "compacted") ||
    (policy.replay !== "safe" &&
      policy.replay !== "ambiguous" &&
      policy.replay !== "owner-managed") ||
    !fence ||
    typeof policy.reason !== "string" ||
    !REASONS.has(policy.reason as DeliveryQueueTerminalReason) ||
    (policy.payload !== "present" && policy.payload !== "none") ||
    (policy.cleanup !== "pending" &&
      policy.cleanup !== "media_pending" &&
      policy.cleanup !== "complete") ||
    (policy.evidence !== undefined &&
      (typeof policy.evidence !== "string" ||
        !EVIDENCE.has(policy.evidence as NonNullable<DeliveryQueueTerminalPolicy["evidence"]>))) ||
    (policy.settlementOutcome !== undefined &&
      policy.settlementOutcome !== "moved-to-failed" &&
      policy.settlementOutcome !== "recovered") ||
    (policy.owner !== undefined &&
      policy.owner !== "durable_delivery" &&
      policy.owner !== "subagent_completion") ||
    (policy.detailExpiresAt !== undefined && !isPositiveSafeInteger(policy.detailExpiresAt))
  ) {
    return undefined;
  }
  return {
    version: 1,
    detail: policy.detail,
    replay: policy.replay,
    fence,
    reason: policy.reason as DeliveryQueueTerminalReason,
    payload: policy.payload,
    cleanup: policy.cleanup,
    ...(policy.evidence === undefined
      ? {}
      : { evidence: policy.evidence as NonNullable<DeliveryQueueTerminalPolicy["evidence"]> }),
    ...(policy.settlementOutcome === undefined
      ? {}
      : { settlementOutcome: policy.settlementOutcome as "moved-to-failed" | "recovered" }),
    ...(policy.owner === undefined
      ? {}
      : { owner: policy.owner as "durable_delivery" | "subagent_completion" }),
    ...(policy.detailExpiresAt === undefined
      ? {}
      : { detailExpiresAt: policy.detailExpiresAt as number }),
  };
}

export function deliveryTerminalFence(
  retention: DeliveryQueueCompletionRetention | undefined,
): DeliveryQueueTerminalFence {
  if (retention === "permanent") {
    return { kind: "permanent" };
  }
  return retention
    ? {
        kind: "producer-bounded",
        idPrefix: retention.idPrefix,
        maxAgeMs: retention.maxAgeMs,
        maxEntries: retention.maxEntries,
      }
    : { kind: "none" };
}

export function unknownDeliveryTerminalPolicy(): DeliveryQueueTerminalPolicy {
  return {
    version: 1,
    detail: "compacted",
    replay: "ambiguous",
    fence: { kind: "permanent" },
    reason: "legacy_unknown",
    payload: "none",
    cleanup: "complete",
    evidence: "legacy_unknown",
  };
}

function validSessionPayload(entry: Record<string, unknown>): boolean {
  if (typeof entry.sessionKey !== "string" || entry.sessionKey.length === 0) {
    return false;
  }
  if (entry.kind === "systemEvent") {
    return typeof entry.text === "string";
  }
  return (
    entry.kind === "agentTurn" &&
    typeof entry.message === "string" &&
    typeof entry.messageId === "string" &&
    entry.messageId.length > 0
  );
}

function hasSessionOwner(entry: Record<string, unknown>): boolean {
  return entry.owner !== undefined || entry.deliveryCompletion !== undefined;
}

function hasSessionClaim(entry: Record<string, unknown>): boolean {
  return (
    entry.requiresProducerClaim === true ||
    entry.producerClaimId !== undefined ||
    entry.completionRetention !== undefined ||
    (entry.failureRetention !== undefined && entry.failureRetention !== "none")
  );
}

function hasSessionSideEffectEvidence(entry: Record<string, unknown>): boolean {
  return (
    entry.deliveryStartedAt !== undefined ||
    entry.settlementOutcome !== undefined ||
    entry.acknowledgedAt !== undefined ||
    entry.platformSendAttemptId !== undefined ||
    entry.platformSendStartedAt !== undefined
  );
}

function validSessionEnvelope(entry: Record<string, unknown>, expectedId: string): boolean {
  return (
    entry.id === expectedId &&
    isNonNegativeSafeInteger(entry.enqueuedAt) &&
    isNonNegativeSafeInteger(entry.retryCount) &&
    (entry.attemptCount === undefined || isNonNegativeSafeInteger(entry.attemptCount)) &&
    (entry.lastAttemptAt === undefined || isNonNegativeSafeInteger(entry.lastAttemptAt)) &&
    (entry.availableAt === undefined || isNonNegativeSafeInteger(entry.availableAt)) &&
    (entry.maxRetries === undefined || isNonNegativeSafeInteger(entry.maxRetries)) &&
    validSessionPayload(entry)
  );
}

type LegacySubagentCompletionOwner = {
  kind: "subagent_completion";
  runId: string;
  taskId: string;
  generation: number;
  deadlineAt: number;
};

function parseLegacySubagentCompletionOwner(value: unknown): LegacySubagentCompletionOwner | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).toSorted();
  if (
    keys.length !== 5 ||
    keys[0] !== "deadlineAt" ||
    keys[1] !== "generation" ||
    keys[2] !== "kind" ||
    keys[3] !== "runId" ||
    keys[4] !== "taskId" ||
    value.kind !== "subagent_completion" ||
    typeof value.runId !== "string" ||
    value.runId.trim().length === 0 ||
    typeof value.taskId !== "string" ||
    value.taskId.trim().length === 0 ||
    !isPositiveSafeInteger(value.generation) ||
    !isNonNegativeSafeInteger(value.deadlineAt)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    runId: value.runId,
    taskId: value.taskId,
    generation: value.generation,
    deadlineAt: value.deadlineAt,
  };
}

function hasForeignSessionOwnerClaim(entry: Record<string, unknown>): boolean {
  return (
    entry.deliveryCompletion !== undefined ||
    entry.requiresProducerClaim !== undefined ||
    entry.producerClaimId !== undefined ||
    entry.completionRetention !== undefined ||
    (entry.failureRetention !== undefined && entry.failureRetention !== "permanent")
  );
}

/** Classifies a policy-free failed session row without inferring owner or side-effect state. */
export function classifyLegacySessionTerminalPolicy(
  value: unknown,
  expectedId: string,
  terminalAt: unknown,
): LegacySessionTerminalPolicyClassification {
  if (!isRecord(value)) {
    return { classified: false, reason: "legacy_unknown" };
  }
  if (Object.hasOwn(value, "terminalPolicy")) {
    return { classified: false, reason: "legacy_unknown" };
  }
  if (value.recoveryState === FAILED_TERMINAL_RECOVERY_STATE) {
    return { classified: false, reason: "compacted" };
  }
  if (!validSessionEnvelope(value, expectedId)) {
    return { classified: false, reason: "legacy_unknown" };
  }
  if (value.owner !== undefined) {
    const owner = parseLegacySubagentCompletionOwner(value.owner);
    if (
      !owner ||
      !isNonNegativeSafeInteger(terminalAt) ||
      hasForeignSessionOwnerClaim(value) ||
      value.recoveryState !== undefined
    ) {
      return { classified: false, reason: "legacy_unknown" };
    }
    const detailExpiresAt = terminalAt + SUBAGENT_COMPLETION_DETAIL_RETENTION_MS;
    if (!Number.isSafeInteger(detailExpiresAt)) {
      return { classified: false, reason: "legacy_unknown" };
    }
    return {
      classified: true,
      mode: "owner-managed",
      policy: {
        version: 1,
        detail: "full",
        replay: "owner-managed",
        fence: { kind: "permanent" },
        reason: owner.deadlineAt <= terminalAt ? "owner_expired" : "owner_settled",
        payload: "present",
        cleanup: "complete",
        evidence: "owner_managed",
        owner: "subagent_completion",
        detailExpiresAt,
      },
      entry: value as DeliveryQueueEntryState,
    };
  }
  if (hasSessionOwner(value)) {
    return { classified: false, reason: "legacy_unknown" };
  }
  if (hasSessionClaim(value)) {
    return { classified: false, reason: "fenced" };
  }
  if (value.recoveryState !== undefined || hasSessionSideEffectEvidence(value)) {
    return { classified: false, reason: "ambiguous" };
  }
  return {
    classified: true,
    mode: "safe",
    policy: {
      version: 1,
      detail: "full",
      replay: "safe",
      fence: { kind: "none" },
      reason: "retry_exhausted",
      payload: "present",
      cleanup: "complete",
      evidence: "pre_side_effect",
    },
    entry: value as DeliveryQueueEntryState,
  };
}

/** Classifies one failed session entry for producer/operator replay without inferring side effects. */
export function classifySessionFailureReplay(
  value: unknown,
  expectedId: string,
): SessionFailureReplayClassification {
  if (!isRecord(value)) {
    return { ok: false, reason: "legacy_unknown" };
  }
  const policy = parseDeliveryQueueTerminalPolicy(value.terminalPolicy);
  if (policy) {
    if (policy.detail !== "full" || policy.payload !== "present") {
      return { ok: false, reason: "compacted" };
    }
    if (policy.owner !== undefined || hasSessionOwner(value)) {
      return { ok: false, reason: "owner_managed" };
    }
    if (policy.fence.kind !== "none" || hasSessionClaim(value)) {
      return { ok: false, reason: "fenced" };
    }
    if (
      policy.reason === "legacy_unknown" ||
      policy.replay !== "safe" ||
      policy.evidence !== "pre_side_effect" ||
      hasSessionSideEffectEvidence(value)
    ) {
      return { ok: false, reason: "ambiguous" };
    }
    return validSessionEnvelope(value, expectedId)
      ? {
          ok: true,
          source: "canonical",
          policy,
          entry: value as DeliveryQueueEntryState,
        }
      : { ok: false, reason: "legacy_unknown" };
  }
  if (Object.hasOwn(value, "terminalPolicy")) {
    return { ok: false, reason: "legacy_unknown" };
  }
  const legacy = classifyLegacySessionTerminalPolicy(value, expectedId, Date.now());
  if (!legacy.classified) {
    return { ok: false, reason: legacy.reason };
  }
  return legacy.mode === "owner-managed"
    ? { ok: false, reason: "owner_managed" }
    : {
        ok: true,
        source: "legacy",
        policy: legacy.policy,
        entry: legacy.entry,
      };
}

export function compactDeliveryTerminalEntry(params: {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  attemptCount?: number;
  terminalPolicy: DeliveryQueueTerminalPolicy;
}): DeliveryQueueEntryState {
  return {
    id: params.id,
    enqueuedAt: params.enqueuedAt,
    retryCount: params.retryCount,
    ...(Number.isSafeInteger(params.attemptCount) && Number(params.attemptCount) >= 0
      ? { attemptCount: Number(params.attemptCount) }
      : {}),
    recoveryState: FAILED_TERMINAL_RECOVERY_STATE,
    terminalPolicy: {
      ...params.terminalPolicy,
      detail: "compacted",
      payload: "none",
      cleanup: "complete",
    },
  };
}

export function parseTerminalPolicyFromEntryJson(raw: string): {
  entry?: DeliveryQueueEntryState;
  policy?: DeliveryQueueTerminalPolicy;
} {
  try {
    const entry = JSON.parse(raw) as DeliveryQueueEntryState;
    return { entry, policy: parseDeliveryQueueTerminalPolicy(entry.terminalPolicy) };
  } catch {
    return {};
  }
}
