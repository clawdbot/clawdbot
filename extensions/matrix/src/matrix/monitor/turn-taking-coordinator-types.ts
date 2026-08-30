import type { MatrixTurnTakingConfig } from "../../types.js";
import type {
  MatrixOpenClawPreviewEnvelope,
  MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import type { PluginRuntime } from "./runtime-api.js";

export const MEMBERSHIP_CACHE_MS = 5_000;
export const DECISION_CACHE_MS = 10 * 60_000;
export const JOURNAL_TTL_MS = 30 * 60_000;
export const MAX_ROOM_JOURNAL_ENTRIES = 24;
export const MAX_CLASSIFIER_HISTORY = 12;
export const CLASSIFIER_TIMEOUT_MS = 8_000;
export const MAX_CACHED_DECISIONS = 2_000;
export const MAX_CACHED_MEMBERSHIPS = 1_000;
export const MAX_JOURNAL_SCOPES = 256;
export const MAX_JOURNAL_BODY_CHARS = 2_000;
export const MATRIX_ACTIVE_PREVIEW_TTL_MS = 2 * 60_000;
export const MATRIX_TERMINAL_REPLAY_TTL_MS = 30 * 60_000;
export const PREVIEW_TOMBSTONE_TTL_MS = MATRIX_TERMINAL_REPLAY_TTL_MS;
export const PREVIEW_INGRESS_CACHE_MS = 10 * 60_000;
export const MAX_ACTIVE_PREVIEWS = 2_000;
export const MAX_PREVIEW_TOMBSTONES = 4_000;
export const MAX_PREVIEW_INGRESS_RESULTS = 4_000;
export const MAX_EARLY_PREVIEW_REDACTIONS = 4_000;
export const MAX_STANDALONE_FINAL_ASSEMBLIES = 64;
export const MAX_STANDALONE_FINAL_TOMBSTONES = 2_048;
export const MAX_STANDALONE_FINAL_PART_BODY_CHARS = 64 * 1024;
export const MAX_STANDALONE_FINAL_BODY_CHARS = 256 * 1024;
export const FRESHNESS_DEBOUNCE_MS = 200;
export const FRESHNESS_PENDING_INGRESS_TIMEOUT_MS = 5_000;
export const MAX_PENDING_INGRESS_EVENTS = 4_000;
export const MAX_OBSERVED_INGRESS_EVENTS = 4_000;

export type MatrixParticipationDisposition = "strongly-speak" | "strongly-silent" | "neutral";

export type MatrixTurnTakingMember = {
  accountId: string;
  userId: string;
};

export type MatrixTurnTakingCandidate = MatrixTurnTakingMember & {
  agentId: string;
  name?: string;
  aliases: string[];
};

export type MatrixTurnTakingEligibility = {
  eligible: boolean;
  members: MatrixTurnTakingMember[];
  ownerAccountId?: string;
};

export type MatrixParticipationDecision = MatrixTurnTakingEligibility & {
  disposition: MatrixParticipationDisposition;
  baselineSequence?: number;
  initialActivePreviewResponseIds?: string[];
};

export type RegisteredMonitor = {
  accountId: string;
  userId: string;
  homeserver: string;
  client: MatrixClient;
  core: PluginRuntime;
  log: (message: string) => void;
  prepareAccess?: (input: MatrixReceiverAccessInput) => Promise<MatrixReceiverAccess>;
};

export type MatrixReceiverAccessInput = {
  roomId: string;
  senderId: string;
  eventId?: string;
  threadId?: string;
  eventTs?: number;
  trustedEnhancedFinal?: boolean;
};

type MatrixReceiverAccess = {
  agentId: string;
  canParticipate: boolean;
  includesContext: (senderId: string) => boolean;
};

export type MatrixReceiverView = MatrixReceiverAccess & {
  isCurrent: () => boolean;
};

export type RoomMembership = {
  expiresAt: number;
  members?: string[];
  pending?: Promise<string[]>;
};

export type JournalEntry = {
  sequence: number;
  eventId: string;
  senderId: string;
  body: string;
  triggerEventId?: string;
  observedAt: number;
  serverTimestamp?: number;
  kind: "message" | "answer" | "progress";
  state: "final" | "in-progress" | "abandoned" | "redacted";
};

export type PendingIngressEvent = {
  key: string;
  roomId: string;
  eventId: string;
  senderId: string;
  accountRefs: Map<string, number>;
  done: Promise<void>;
  resolve: () => void;
  settled: boolean;
};

export type ActivePreview = {
  sequence: number;
  roomId: string;
  threadId?: string;
  originalEventId: string;
  latestEventId: string;
  senderId: string;
  marker: MatrixOpenClawPreviewMarker;
  body: string;
  bodyHash: string;
  observedAt: number;
  expiresAt?: number;
  serverTimestamp?: number;
  sourceEventIds: Set<string>;
};

export type PreviewTombstone = {
  expiresAt: number;
  senderId: string;
  marker: MatrixOpenClawPreviewMarker;
  sourceEventId: string;
  sourceEventIds: Set<string>;
  body: string;
  hadAuthorizedVisibility: boolean;
  redacted: boolean;
};

type StandaloneFinalPart = {
  eventId: string;
  envelope: MatrixOpenClawPreviewEnvelope;
  body: string;
};

export type StandaloneFinalAssembly = {
  roomId: string;
  senderId: string;
  responseId: string;
  observedAt: number;
  marker: MatrixOpenClawPreviewMarker;
  parts: Map<number, StandaloneFinalPart>;
  sourceEventIds: Set<string>;
  promotedAccounts: Set<string>;
  promotedEvent?: MatrixRawEvent;
  redacted: boolean;
  bodyChars: number;
};

export type StandaloneFinalTombstone = {
  expiresAt: number;
  roomId: string;
  senderId: string;
  responseId: string;
  marker: MatrixOpenClawPreviewMarker;
  rootEventId: string;
  sourceEventIds: Set<string>;
  partEventIds: Map<number, string>;
  promotedAccounts: Set<string>;
  hadAuthorizedVisibility: boolean;
  redacted: boolean;
};

export type MatrixPreviewIngressResult =
  | { kind: "ordinary" }
  | { kind: "consume"; reason: string }
  | { kind: "authorize"; reason: string; event: MatrixRawEvent; observationId: string }
  | { kind: "promote"; event: MatrixRawEvent; observationId: string };

export type MatrixPreviewAuthorization = {
  roomId: string;
  senderId: string;
  originalEventId: string;
  envelope: MatrixOpenClawPreviewEnvelope;
  expiresAt: number;
  promotedEvent?: MatrixRawEvent;
};

export type PreparedPreviewIngress = {
  result: MatrixPreviewIngressResult;
  authorization?: MatrixPreviewAuthorization;
};

export type MatrixTurnTakingFreshnessEntry = {
  sequence: number;
  eventId: string;
  senderId: string;
  body: string;
  kind: "message" | "answer" | "progress";
  state: "final" | "in-progress" | "abandoned" | "redacted";
  timestamp?: number;
  responseId?: string;
  revision?: number;
};

export type MatrixRosterResolution = {
  members: MatrixTurnTakingMember[];
  executionMonitor?: RegisteredMonitor;
};

export type CachedDecision = {
  expiresAt: number;
  pending: Promise<{
    members: MatrixTurnTakingMember[];
    ownerAccountId?: string;
    baselineSequence?: number;
    dispositions: Map<string, MatrixParticipationDisposition>;
  }>;
};

export function parseNextStepAction(
  text: string,
): "redraft" | "discard" | "send-as-is" | undefined {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    // SAFETY: The JSON value is proven to be a non-array object before its closed keys are inspected.
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "action")) {
      return undefined;
    }
    return record.action === "redraft" ||
      record.action === "discard" ||
      record.action === "send-as-is"
      ? record.action
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeUniqueAliases(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function uniqueExactStrings(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function normalizeUserId(value: string): string {
  return value.trim();
}

export function localpart(userId: string): string | undefined {
  return /^@([^:]+):/.exec(userId.trim())?.[1];
}

export function boundedMapSet<TKey, TValue>(
  map: Map<TKey, TValue>,
  key: TKey,
  value: TValue,
  maxSize: number,
): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

export function parseClassifierOutput(
  text: string,
  candidates: readonly MatrixTurnTakingCandidate[],
): Map<string, MatrixParticipationDisposition> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  // SAFETY: The parsed classifier root is proven to be a non-array object before field reads.
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "decisions") || !Array.isArray(root.decisions)) {
    return undefined;
  }
  const allowed = new Set(candidates.map((candidate) => candidate.accountId));
  if (root.decisions.length !== candidates.length) {
    return undefined;
  }
  const dispositions = new Map<string, MatrixParticipationDisposition>();
  for (const rawDecision of root.decisions) {
    if (typeof rawDecision !== "object" || rawDecision === null || Array.isArray(rawDecision)) {
      return undefined;
    }
    // SAFETY: Each decision is proven to be a non-array object before its closed shape is validated.
    const decision = rawDecision as Record<string, unknown>;
    if (
      Object.keys(decision).some((key) => key !== "accountId" && key !== "disposition") ||
      typeof decision.accountId !== "string" ||
      !allowed.has(decision.accountId) ||
      dispositions.has(decision.accountId) ||
      (decision.disposition !== "strongly-speak" &&
        decision.disposition !== "strongly-silent" &&
        decision.disposition !== "neutral")
    ) {
      return undefined;
    }
    dispositions.set(decision.accountId, decision.disposition);
  }
  return dispositions.size === candidates.length ? dispositions : undefined;
}

export function neutralDispositions(
  candidates: readonly Pick<MatrixTurnTakingMember, "accountId">[],
): Map<string, MatrixParticipationDisposition> {
  return new Map(candidates.map((candidate) => [candidate.accountId, "neutral"] as const));
}

export function resolveMatrixTurnTakingConfig(
  config: MatrixTurnTakingConfig | undefined,
): Required<MatrixTurnTakingConfig> {
  return {
    enabled: config?.enabled === true,
    redraftDepth: config?.redraftDepth ?? 1,
    nextStep: config?.nextStep ?? { decider: "ai" },
  };
}
