import { randomBytes } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { privateFileStore } from "../infra/private-file-store.js";
import {
  DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS,
  DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  resolveCommitmentsConfig,
} from "./config.js";
import type {
  CommitmentCandidate,
  CommitmentExtractionItem,
  CommitmentRecord,
  CommitmentScope,
  CommitmentStatus,
  CommitmentStoreFile,
} from "./types.js";

const STORE_VERSION = 1 as const;
const ROLLING_DAY_MS = 24 * 60 * 60 * 1000;
const COMMITMENT_KINDS = new Set([
  "event_check_in",
  "deadline_check",
  "care_check_in",
  "open_loop",
]);
const COMMITMENT_SENSITIVITIES = new Set(["routine", "personal", "care"]);
const COMMITMENT_SOURCES = new Set(["inferred_user_context", "agent_promise"]);
const COMMITMENT_STATUSES = new Set(["pending", "sent", "dismissed", "snoozed", "expired"]);

type LoadedCommitmentStore = {
  store: CommitmentStoreFile;
  hadLegacySourceText: boolean;
};

function defaultCommitmentStorePath(): string {
  return path.join(resolveStateDir(), "commitments", "commitments.json");
}

export function resolveCommitmentStorePath(storePath?: string): string {
  const trimmed = storePath?.trim();
  if (!trimmed) {
    return defaultCommitmentStorePath();
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(expandHomePrefix(trimmed));
  }
  return path.resolve(trimmed);
}

function emptyStore(): CommitmentStoreFile {
  return { version: STORE_VERSION, commitments: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function coerceCommitment(raw: unknown): CommitmentRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  if (!dueWindow) {
    return undefined;
  }

  const id = normalizeRequiredString(raw.id);
  const agentId = normalizeRequiredString(raw.agentId);
  const sessionKey = normalizeRequiredString(raw.sessionKey);
  const channel = normalizeRequiredString(raw.channel);
  const reason = normalizeRequiredString(raw.reason);
  const suggestedText = normalizeRequiredString(raw.suggestedText);
  const dedupeKey = normalizeRequiredString(raw.dedupeKey);
  const kind = normalizeRequiredString(raw.kind);
  const sensitivity = normalizeRequiredString(raw.sensitivity);
  const source = normalizeRequiredString(raw.source);
  const status = normalizeRequiredString(raw.status);
  const confidence = normalizeNonNegativeNumber(raw.confidence);
  const createdAtMs = normalizeNonNegativeNumber(raw.createdAtMs);
  const updatedAtMs = normalizeNonNegativeNumber(raw.updatedAtMs);
  const attempts = normalizeNonNegativeInteger(raw.attempts);
  const earliestMs = normalizeNonNegativeNumber(dueWindow.earliestMs);
  const latestMs = normalizeNonNegativeNumber(dueWindow.latestMs);
  const timezone = normalizeRequiredString(dueWindow.timezone);
  const accountId = normalizeOptionalString(raw.accountId);
  const to = normalizeOptionalString(raw.to);
  const threadId = normalizeOptionalString(raw.threadId);
  const senderId = normalizeOptionalString(raw.senderId);
  const sourceMessageId = normalizeOptionalString(raw.sourceMessageId);
  const sourceRunId = normalizeOptionalString(raw.sourceRunId);
  const lastAttemptAtMs = normalizeNonNegativeNumber(raw.lastAttemptAtMs);
  const sentAtMs = normalizeNonNegativeNumber(raw.sentAtMs);
  const dismissedAtMs = normalizeNonNegativeNumber(raw.dismissedAtMs);
  const snoozedUntilMs = normalizeNonNegativeNumber(raw.snoozedUntilMs);
  const expiredAtMs = normalizeNonNegativeNumber(raw.expiredAtMs);

  if (
    !id ||
    !agentId ||
    !sessionKey ||
    !channel ||
    !reason ||
    !suggestedText ||
    !dedupeKey ||
    !kind ||
    !sensitivity ||
    !source ||
    !status ||
    !COMMITMENT_KINDS.has(kind) ||
    !COMMITMENT_SENSITIVITIES.has(sensitivity) ||
    !COMMITMENT_SOURCES.has(source) ||
    !COMMITMENT_STATUSES.has(status) ||
    confidence === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    attempts === undefined ||
    earliestMs === undefined ||
    latestMs === undefined ||
    !timezone ||
    latestMs < earliestMs
  ) {
    return undefined;
  }

  return {
    id,
    agentId,
    sessionKey,
    channel,
    ...(accountId ? { accountId } : {}),
    ...(to ? { to } : {}),
    ...(threadId ? { threadId } : {}),
    ...(senderId ? { senderId } : {}),
    kind: kind as CommitmentRecord["kind"],
    sensitivity: sensitivity as CommitmentRecord["sensitivity"],
    source: source as CommitmentRecord["source"],
    status: status as CommitmentRecord["status"],
    reason,
    suggestedText,
    dedupeKey,
    confidence,
    dueWindow: { earliestMs, latestMs, timezone },
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
    createdAtMs,
    updatedAtMs,
    attempts,
    ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
    ...(sentAtMs !== undefined ? { sentAtMs } : {}),
    ...(dismissedAtMs !== undefined ? { dismissedAtMs } : {}),
    ...(snoozedUntilMs !== undefined ? { snoozedUntilMs } : {}),
    ...(expiredAtMs !== undefined ? { expiredAtMs } : {}),
  };
}

function hasLegacySourceText(raw: unknown): boolean {
  return isRecord(raw) && ("sourceUserText" in raw || "sourceAssistantText" in raw);
}

function stripLegacySourceText(commitment: CommitmentRecord): CommitmentRecord {
  const stripped = { ...commitment };
  // The extraction prompt can read the source turn, but delivery state should
  // not persist or replay raw conversation text into later heartbeat turns.
  delete stripped.sourceUserText;
  delete stripped.sourceAssistantText;
  return stripped;
}

function sanitizeStoreForWrite(store: CommitmentStoreFile): CommitmentStoreFile {
  return {
    ...store,
    commitments: store.commitments.map(stripLegacySourceText),
  };
}

async function loadCommitmentStoreInternal(storePath?: string): Promise<LoadedCommitmentStore> {
  const resolved = resolveCommitmentStorePath(storePath);
  try {
    const parsed = await privateFileStore(path.dirname(resolved)).readJsonIfExists(
      path.basename(resolved),
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== STORE_VERSION ||
      !Array.isArray(parsed.commitments)
    ) {
      return { store: emptyStore(), hadLegacySourceText: false };
    }
    let hadLegacySourceText = false;
    return {
      store: {
        version: STORE_VERSION,
        commitments: parsed.commitments.flatMap((entry) => {
          hadLegacySourceText ||= hasLegacySourceText(entry);
          const coerced = coerceCommitment(entry);
          return coerced ? [coerced] : [];
        }),
      },
      hadLegacySourceText,
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { store: emptyStore(), hadLegacySourceText: false };
    }
    throw err;
  }
}

export async function loadCommitmentStore(storePath?: string): Promise<CommitmentStoreFile> {
  return (await loadCommitmentStoreInternal(storePath)).store;
}

export async function saveCommitmentStore(
  storePath: string | undefined,
  store: CommitmentStoreFile,
): Promise<void> {
  const resolved = resolveCommitmentStorePath(storePath);
  await privateFileStore(path.dirname(resolved)).writeJson(
    path.basename(resolved),
    sanitizeStoreForWrite(store),
  );
}

function generateCommitmentId(nowMs: number): string {
  return `cm_${nowMs.toString(36)}_${randomBytes(5).toString("hex")}`;
}

function scopeValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function buildCommitmentScopeKey(scope: CommitmentScope): string {
  return [
    scopeValue(scope.agentId),
    scopeValue(scope.sessionKey),
    scopeValue(scope.channel),
    scopeValue(scope.accountId),
    scopeValue(scope.to),
    scopeValue(scope.threadId),
    scopeValue(scope.senderId),
  ].join("\u001f");
}

function isActiveStatus(status: CommitmentStatus): boolean {
  return status === "pending" || status === "snoozed";
}

function candidateToRecord(params: {
  item: CommitmentExtractionItem;
  candidate: CommitmentCandidate;
  nowMs: number;
  earliestMs: number;
  latestMs: number;
  timezone: string;
}): CommitmentRecord {
  return {
    id: generateCommitmentId(params.nowMs),
    agentId: params.item.agentId,
    sessionKey: params.item.sessionKey,
    channel: params.item.channel,
    ...(params.item.accountId ? { accountId: params.item.accountId } : {}),
    ...(params.item.to ? { to: params.item.to } : {}),
    ...(params.item.threadId ? { threadId: params.item.threadId } : {}),
    ...(params.item.senderId ? { senderId: params.item.senderId } : {}),
    kind: params.candidate.kind,
    sensitivity: params.candidate.sensitivity,
    source: params.candidate.source,
    status: "pending",
    reason: params.candidate.reason.trim(),
    suggestedText: params.candidate.suggestedText.trim(),
    dedupeKey: params.candidate.dedupeKey.trim(),
    confidence: params.candidate.confidence,
    dueWindow: {
      earliestMs: params.earliestMs,
      latestMs: params.latestMs,
      timezone: params.timezone,
    },
    ...(params.item.sourceMessageId ? { sourceMessageId: params.item.sourceMessageId } : {}),
    ...(params.item.sourceRunId ? { sourceRunId: params.item.sourceRunId } : {}),
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    attempts: 0,
  };
}

function expireAfterMs(): number {
  return DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS * 60 * 60 * 1000;
}

function expireStaleCommitmentsInStore(store: CommitmentStoreFile, nowMs: number): boolean {
  const staleAfterMs = expireAfterMs();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (
      !isActiveStatus(commitment.status) ||
      commitment.dueWindow.latestMs + staleAfterMs >= nowMs
    ) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      status: "expired",
      expiredAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  });
  return changed;
}

async function loadCommitmentStoreWithExpiredMarked(nowMs: number): Promise<CommitmentStoreFile> {
  const { store, hadLegacySourceText } = await loadCommitmentStoreInternal();
  if (expireStaleCommitmentsInStore(store, nowMs) || hadLegacySourceText) {
    await saveCommitmentStore(undefined, store);
  }
  return store;
}

export async function listPendingCommitmentsForScope(params: {
  cfg?: OpenClawConfig;
  scope: CommitmentScope;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const scopeKey = buildCommitmentScopeKey(params.scope);
  const limit = params.limit ?? 20;
  return store.commitments
    .filter(
      (commitment) =>
        buildCommitmentScopeKey(commitment) === scopeKey &&
        isActiveStatus(commitment.status) &&
        (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    )
    .slice(0, limit);
}

export async function upsertInferredCommitments(params: {
  cfg?: OpenClawConfig;
  item: CommitmentExtractionItem;
  candidates: Array<{
    candidate: CommitmentCandidate;
    earliestMs: number;
    latestMs: number;
    timezone: string;
  }>;
  nowMs?: number;
}): Promise<CommitmentRecord[]> {
  if (params.candidates.length === 0) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const created: CommitmentRecord[] = [];
  const scopeKey = buildCommitmentScopeKey(params.item);

  for (const entry of params.candidates) {
    const dedupeKey = entry.candidate.dedupeKey.trim();
    const existingIndex = store.commitments.findIndex(
      (commitment) =>
        buildCommitmentScopeKey(commitment) === scopeKey &&
        commitment.dedupeKey === dedupeKey &&
        isActiveStatus(commitment.status),
    );
    if (existingIndex >= 0) {
      const existing = store.commitments[existingIndex];
      store.commitments[existingIndex] = {
        ...existing,
        reason: entry.candidate.reason.trim() || existing.reason,
        suggestedText: entry.candidate.suggestedText.trim() || existing.suggestedText,
        confidence: Math.max(existing.confidence, entry.candidate.confidence),
        dueWindow: {
          earliestMs: Math.min(existing.dueWindow.earliestMs, entry.earliestMs),
          latestMs: Math.max(existing.dueWindow.latestMs, entry.latestMs),
          timezone: entry.timezone,
        },
        updatedAtMs: nowMs,
      };
      continue;
    }
    const record = candidateToRecord({
      item: params.item,
      candidate: entry.candidate,
      nowMs,
      earliestMs: entry.earliestMs,
      latestMs: entry.latestMs,
      timezone: entry.timezone,
    });
    store.commitments.push(record);
    created.push(record);
  }
  await saveCommitmentStore(undefined, store);
  return created;
}

function countSentCommitmentsForSession(params: {
  store: CommitmentStoreFile;
  agentId: string;
  sessionKey: string;
  nowMs: number;
}): number {
  const sinceMs = params.nowMs - ROLLING_DAY_MS;
  return params.store.commitments.filter(
    (commitment) =>
      commitment.agentId === params.agentId &&
      commitment.sessionKey === params.sessionKey &&
      commitment.status === "sent" &&
      (commitment.sentAtMs ?? 0) >= sinceMs,
  ).length;
}

export async function listDueCommitmentsForSession(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const remainingToday =
    resolved.maxPerDay -
    countSentCommitmentsForSession({
      store,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      nowMs,
    });
  if (remainingToday <= 0) {
    return [];
  }
  const limit = Math.min(
    params.limit ?? DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
    remainingToday,
    DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  );
  const staleAfterMs = expireAfterMs();
  return store.commitments
    .filter(
      (commitment) =>
        commitment.agentId === params.agentId &&
        commitment.sessionKey === params.sessionKey &&
        isActiveStatus(commitment.status) &&
        commitment.dueWindow.earliestMs <= nowMs &&
        commitment.dueWindow.latestMs + staleAfterMs >= nowMs &&
        (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    )
    .slice(0, limit);
}

export async function listDueCommitmentSessionKeys(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  nowMs?: number;
  limit?: number;
}): Promise<string[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const staleAfterMs = expireAfterMs();
  const keys = new Set<string>();
  for (const commitment of store.commitments) {
    if (
      commitment.agentId === params.agentId &&
      isActiveStatus(commitment.status) &&
      commitment.dueWindow.earliestMs <= nowMs &&
      commitment.dueWindow.latestMs + staleAfterMs >= nowMs &&
      (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs) &&
      countSentCommitmentsForSession({
        store,
        agentId: params.agentId,
        sessionKey: commitment.sessionKey,
        nowMs,
      }) < resolved.maxPerDay
    ) {
      keys.add(commitment.sessionKey);
    }
    if (params.limit && keys.size >= params.limit) {
      break;
    }
  }
  return [...keys].toSorted();
}

export async function markCommitmentsAttempted(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  nowMs?: number;
}): Promise<void> {
  if (params.ids.length === 0) {
    return;
  }
  const idSet = new Set(params.ids);
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStore();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (!idSet.has(commitment.id)) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      attempts: commitment.attempts + 1,
      lastAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  });
  if (changed) {
    await saveCommitmentStore(undefined, store);
  }
}

export async function markCommitmentsStatus(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  status: Extract<CommitmentStatus, "sent" | "dismissed" | "expired">;
  nowMs?: number;
}): Promise<void> {
  if (params.ids.length === 0) {
    return;
  }
  const idSet = new Set(params.ids);
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStore();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (!idSet.has(commitment.id) || !isActiveStatus(commitment.status)) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      status: params.status,
      updatedAtMs: nowMs,
      ...(params.status === "sent" ? { sentAtMs: nowMs } : {}),
      ...(params.status === "dismissed" ? { dismissedAtMs: nowMs } : {}),
      ...(params.status === "expired" ? { expiredAtMs: nowMs } : {}),
    };
  });
  if (changed) {
    await saveCommitmentStore(undefined, store);
  }
}

export async function listCommitments(params?: {
  cfg?: OpenClawConfig;
  status?: CommitmentStatus;
  agentId?: string;
}): Promise<CommitmentRecord[]> {
  const store = await loadCommitmentStoreWithExpiredMarked(Date.now());
  return store.commitments
    .filter(
      (commitment) =>
        (!params?.status || commitment.status === params.status) &&
        (!params?.agentId || commitment.agentId === params.agentId),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    );
}
