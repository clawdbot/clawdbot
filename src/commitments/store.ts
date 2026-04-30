import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { expandHomePrefix } from "../infra/home-dir.js";
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

function coerceCommitment(raw: unknown): CommitmentRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  if (!dueWindow) {
    return undefined;
  }
  const requiredStrings = [
    raw.id,
    raw.agentId,
    raw.sessionKey,
    raw.channel,
    raw.kind,
    raw.sensitivity,
    raw.source,
    raw.status,
    raw.reason,
    raw.suggestedText,
    raw.dedupeKey,
    raw.sourceUserText,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  if (
    typeof raw.confidence !== "number" ||
    typeof raw.createdAtMs !== "number" ||
    typeof raw.updatedAtMs !== "number" ||
    typeof raw.attempts !== "number" ||
    typeof dueWindow.earliestMs !== "number" ||
    typeof dueWindow.latestMs !== "number" ||
    typeof dueWindow.timezone !== "string"
  ) {
    return undefined;
  }
  return raw as CommitmentRecord;
}

export async function loadCommitmentStore(storePath?: string): Promise<CommitmentStoreFile> {
  const resolved = resolveCommitmentStorePath(storePath);
  try {
    const raw = await fs.promises.readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== STORE_VERSION ||
      !Array.isArray(parsed.commitments)
    ) {
      return emptyStore();
    }
    return {
      version: STORE_VERSION,
      commitments: parsed.commitments.flatMap((entry) => {
        const coerced = coerceCommitment(entry);
        return coerced ? [coerced] : [];
      }),
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return emptyStore();
    }
    throw err;
  }
}

export async function saveCommitmentStore(
  storePath: string | undefined,
  store: CommitmentStoreFile,
): Promise<void> {
  const resolved = resolveCommitmentStorePath(storePath);
  const dir = path.dirname(resolved);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store, null, 2);
  const tmp = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600).catch(() => undefined);
  await fs.promises.rename(tmp, resolved);
  await fs.promises.chmod(resolved, 0o600).catch(() => undefined);
}

function generateCommitmentId(nowMs: number): string {
  return `cm_${nowMs.toString(36)}_${randomBytes(5).toString("hex")}`;
}

function scopeValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function buildCommitmentScopeKey(scope: CommitmentScope): string {
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
    sourceUserText: params.item.userText,
    ...(params.item.assistantText ? { sourceAssistantText: params.item.assistantText } : {}),
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    attempts: 0,
  };
}

export async function listPendingCommitmentsForScope(params: {
  cfg?: OpenClawConfig;
  scope: CommitmentScope;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const store = await loadCommitmentStore();
  const scopeKey = buildCommitmentScopeKey(params.scope);
  const nowMs = params.nowMs ?? Date.now();
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
  const store = await loadCommitmentStore();
  const nowMs = params.nowMs ?? Date.now();
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
  const store = await loadCommitmentStore();
  const nowMs = params.nowMs ?? Date.now();
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
  const expireAfterMs = DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS * 60 * 60 * 1000;
  return store.commitments
    .filter(
      (commitment) =>
        commitment.agentId === params.agentId &&
        commitment.sessionKey === params.sessionKey &&
        isActiveStatus(commitment.status) &&
        commitment.dueWindow.earliestMs <= nowMs &&
        commitment.dueWindow.latestMs + expireAfterMs >= nowMs &&
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
  const store = await loadCommitmentStore();
  const nowMs = params.nowMs ?? Date.now();
  const expireAfterMs = DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS * 60 * 60 * 1000;
  const keys = new Set<string>();
  for (const commitment of store.commitments) {
    if (
      commitment.agentId === params.agentId &&
      isActiveStatus(commitment.status) &&
      commitment.dueWindow.earliestMs <= nowMs &&
      commitment.dueWindow.latestMs + expireAfterMs >= nowMs &&
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
  const store = await loadCommitmentStore();
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
