// Persists pairing challenges and approved channel account bindings in shared SQLite state.
import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveAllowFromAccountId } from "./pairing-store-keys.js";
import {
  readChannelPairingState,
  readChannelPairingStateFromDatabase,
  resolvePairingRequestAccountId,
  sqliteOptionsForEnv,
  writeChannelPairingStateToDatabase,
} from "./pairing-store-sqlite.js";
import type { PairingChannel } from "./pairing-store.types.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 500;
export const CHANNEL_PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
export const CHANNEL_PAIRING_PENDING_MAX = 3;

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

/** Stable opaque id for approving a request without exposing its human pairing code. */
export function resolveChannelPairingRequestId(
  channel: PairingChannel,
  request: PairingRequest,
): string {
  const accountId = resolvePairingRequestAccountId(request);
  return crypto
    .createHash("sha256")
    .update(`${channel}\0${accountId}\0${request.id}\0${request.createdAt}`)
    .digest("base64url")
    .slice(0, 32);
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  return createdAt === null || nowMs - createdAt > CHANNEL_PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}

function normalizePairingAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId);
}

function requestMatchesAccountId(entry: PairingRequest, normalizedAccountId: string): boolean {
  return !normalizedAccountId || resolvePairingRequestAccountId(entry) === normalizedAccountId;
}

function pruneExcessRequestsByAccount(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const grouped = new Map<string, Array<{ index: number; request: PairingRequest }>>();
  for (const [index, entry] of reqs.entries()) {
    const accountId = resolvePairingRequestAccountId(entry);
    const current = grouped.get(accountId);
    if (current) {
      current.push({ index, request: entry });
    } else {
      grouped.set(accountId, [{ index, request: entry }]);
    }
  }

  const droppedIndexes = new Set<number>();
  for (const entries of grouped.values()) {
    if (entries.length <= maxPending) {
      continue;
    }
    const sorted = entries.toSorted(
      (left, right) => resolveLastSeenAt(left.request) - resolveLastSeenAt(right.request),
    );
    for (const { index } of sorted.slice(0, sorted.length - maxPending)) {
      droppedIndexes.add(index);
    }
  }
  return droppedIndexes.size === 0
    ? { requests: reqs, removed: false }
    : { requests: reqs.filter((_, index) => !droppedIndexes.has(index)), removed: true };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error(
    `failed to generate unique pairing code after ${PAIRING_CODE_MAX_ATTEMPTS} attempts; existing code count: ${existing.size}`,
  );
}

function normalizeId(value: string | number): string {
  return normalizeStringifiedOptionalString(value) ?? "";
}

function resolvePairingAdapter(
  channel: PairingChannel,
  pairingAdapter?: ChannelPairingAdapter,
): ChannelPairingAdapter | undefined {
  return pairingAdapter ?? getPairingAdapter(channel) ?? undefined;
}

function normalizeAllowEntry(
  channel: PairingChannel,
  entry: string,
  pairingAdapter?: ChannelPairingAdapter,
): string {
  const trimmed = entry.trim();
  if (!trimmed || trimmed === "*") {
    return "";
  }
  const adapter = resolvePairingAdapter(channel, pairingAdapter);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  const normalizedEntry = normalizeOptionalString(normalized) ?? "";
  return normalizedEntry === "*" ? "" : normalizedEntry;
}

function normalizeAllowFromInput(
  channel: PairingChannel,
  entry: string | number,
  pairingAdapter?: ChannelPairingAdapter,
): string {
  return normalizeAllowEntry(channel, normalizeId(entry), pairingAdapter);
}

function readAllowFromState(channel: PairingChannel, env: NodeJS.ProcessEnv, accountId?: string) {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  return (readChannelPairingState(channel, env).allowFrom?.[resolvedAccountId] ?? []).slice();
}

async function updateAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
  apply: (current: string[], normalized: string) => string[] | null;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const accountId = resolveAllowFromAccountId(params.accountId);
  const normalized = normalizeAllowFromInput(params.channel, params.entry, params.pairingAdapter);
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const current = (state.allowFrom?.[accountId] ?? []).slice();
    if (!normalized) {
      return { changed: false, allowFrom: current };
    }
    const next = params.apply(current, normalized);
    if (!next) {
      return { changed: false, allowFrom: current };
    }
    state.allowFrom ??= {};
    state.allowFrom[accountId] = next;
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { changed: true, allowFrom: next };
  }, sqliteOptionsForEnv(env));
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  return readAllowFromState(channel, env, accountId);
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  return readAllowFromState(channel, env, accountId);
}

type AllowFromStoreEntryUpdateParams = {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
};

export async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry({
    ...params,
    apply: (current, normalized) =>
      current.includes(normalized) ? null : [...current, normalized],
  });
}

export async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry({
    ...params,
    apply: (current, normalized) => {
      const next = current.filter((entry) => entry !== normalized);
      return next.length === current.length ? null : next;
    },
  });
}

export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<PairingRequest[]> {
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, channel);
    const expired = pruneExpiredRequests(state.requests, Date.now());
    const capped = pruneExcessRequestsByAccount(expired.requests, CHANNEL_PAIRING_PENDING_MAX);
    if (expired.removed || capped.removed) {
      state.requests = capped.requests;
      writeChannelPairingStateToDatabase(database, channel, state);
    }
    const normalizedAccountId = normalizePairingAccountId(accountId);
    return capped.requests
      .filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
      .toSorted((left, right) => {
        const createdOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdOrder !== 0) {
          return createdOrder;
        }
        const accountOrder = resolvePairingRequestAccountId(left).localeCompare(
          resolvePairingRequestAccountId(right),
        );
        return accountOrder || left.id.localeCompare(right.id);
      });
  }, sqliteOptionsForEnv(env));
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  return runOpenClawStateWriteTransaction((database) => {
    const now = new Date().toISOString();
    const id = normalizeId(params.id);
    const accountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const baseMeta = params.meta
      ? Object.fromEntries(
          Object.entries(params.meta)
            .map(([key, value]) => [key, normalizeOptionalString(value) ?? ""] as const)
            .filter(([, value]) => Boolean(value)),
        )
      : undefined;
    const meta = { ...baseMeta, accountId };
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const expired = pruneExpiredRequests(state.requests, Date.now());
    let requests = expired.requests;
    const existingIndex = requests.findIndex(
      (request) => request.id === id && requestMatchesAccountId(request, accountId),
    );
    const existingCodes = new Set(
      requests.map((request) => (normalizeOptionalString(request.code) ?? "").toUpperCase()),
    );

    if (existingIndex >= 0) {
      const existing = requests[existingIndex];
      const code = normalizeOptionalString(existing?.code) || generateUniqueCode(existingCodes);
      requests[existingIndex] = {
        id,
        code,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        meta,
      };
      state.requests = pruneExcessRequestsByAccount(requests, CHANNEL_PAIRING_PENDING_MAX).requests;
      writeChannelPairingStateToDatabase(database, params.channel, state);
      return { code, created: false };
    }

    const capped = pruneExcessRequestsByAccount(requests, CHANNEL_PAIRING_PENDING_MAX);
    requests = capped.requests;
    const accountRequestCount = requests.filter((request) =>
      requestMatchesAccountId(request, accountId),
    ).length;
    if (CHANNEL_PAIRING_PENDING_MAX > 0 && accountRequestCount >= CHANNEL_PAIRING_PENDING_MAX) {
      if (expired.removed || capped.removed) {
        state.requests = requests;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return { code: "", created: false };
    }

    const code = generateUniqueCode(existingCodes);
    state.requests = [...requests, { id, code, createdAt: now, lastSeenAt: now, meta }];
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { code, created: true };
  }, sqliteOptionsForEnv(env));
}

type ResolvePairingRequestParams = {
  channel: PairingChannel;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
  matches: (request: PairingRequest) => boolean;
  approve: boolean;
};

async function resolveChannelPairingRequest(
  params: ResolvePairingRequestParams,
): Promise<{ id: string; entry: PairingRequest } | null> {
  const env = params.env ?? process.env;
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const pruned = pruneExpiredRequests(state.requests, Date.now());
    const accountId = normalizePairingAccountId(params.accountId);
    const index = pruned.requests.findIndex(
      (request) => requestMatchesAccountId(request, accountId) && params.matches(request),
    );
    if (index < 0) {
      if (pruned.removed) {
        state.requests = pruned.requests;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return null;
    }
    const entry = pruned.requests[index];
    if (!entry) {
      return null;
    }
    pruned.requests.splice(index, 1);
    state.requests = pruned.requests;

    if (params.approve) {
      const allowAccountId = resolveAllowFromAccountId(
        normalizeOptionalString(params.accountId) ?? normalizeOptionalString(entry.meta?.accountId),
      );
      const currentAllow = state.allowFrom?.[allowAccountId] ?? [];
      const adapter = resolvePairingAdapter(params.channel, params.pairingAdapter);
      // Channels with key-bound handoffs can persist an opaque approval token
      // derived from request metadata instead of a durable sender allowlist id.
      const approvalEntry = adapter?.resolveApprovalStoreEntry
        ? adapter.resolveApprovalStoreEntry({
            id: entry.id,
            ...(entry.meta ? { meta: entry.meta } : {}),
          })
        : entry.id;
      const normalizedAllow =
        approvalEntry == null
          ? ""
          : normalizeAllowFromInput(params.channel, approvalEntry, adapter);
      if (normalizedAllow && !currentAllow.includes(normalizedAllow)) {
        state.allowFrom ??= {};
        state.allowFrom[allowAccountId] = [...currentAllow, normalizedAllow];
      }
    }

    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { id: entry.id, entry };
  }, sqliteOptionsForEnv(env));
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const code = (normalizeNullableString(params.code) ?? "").toUpperCase();
  if (!code) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => request.code.toUpperCase() === code,
    approve: true,
  });
}

/** Approves a pending request by opaque id without exposing its pairing code. */
export async function approveChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  if (!requestId) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => resolveChannelPairingRequestId(params.channel, request) === requestId,
    approve: true,
  });
}

/** Dismisses a pending request without blocking the sender from requesting again. */
export async function dismissChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  if (!requestId) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => resolveChannelPairingRequestId(params.channel, request) === requestId,
    approve: false,
  });
}
