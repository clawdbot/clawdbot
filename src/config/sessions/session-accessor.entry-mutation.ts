import { isDeepStrictEqual } from "node:util";
import type { MsgContext } from "../../auto-reply/templating.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  resolveAccessStorePath,
  loadSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  resolveSessionEntryFromStore,
} from "./session-accessor.entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import {
  appendSqliteTranscriptEvent,
  forkSqliteSessionEntryFromParentTarget,
  forkSqliteSessionTranscriptFromParent,
  recordSqliteInboundSessionMeta,
  updateSqliteSessionLastRoute,
  patchSqliteSessionEntry,
  resolveSqliteSessionParentForkDecision,
} from "./session-accessor.sqlite.js";
import type {
  SessionAccessScope,
  SessionEntryUpdateOptions,
  SessionAbortTargetCutoff,
  SessionAbortTargetContext,
  SessionAbortTargetIdentity,
  SessionAbortTargetResult,
  SessionParentForkDecision,
  ForkSessionFromParentTranscriptResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionEntryFromParentTargetParams,
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptOptions,
  CanonicalizeSessionEntryAliasesResult,
} from "./session-accessor.types.js";
import {
  cloneOptionalSessionEntry as cloneOptionalEntry,
  normalizeTargetStoreKeys,
  resolveFreshestTargetEntry,
} from "./session-entry-selection.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  projectSessionEntryForPersistenceRevision,
  type SessionLifecycleStoreTarget,
} from "./store.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

export async function forkSessionFromParentTranscript(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  return await forkSqliteSessionTranscriptFromParent(params);
}

/**
 * Forks parent transcript content and persists the child entry/alias cleanup in
 * one storage-owned operation.
 */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  return await forkSqliteSessionEntryFromParentTarget(params);
}

/** Resolves whether a parent session is small enough to fork through the active store. */
export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  return await resolveSqliteSessionParentForkDecision(params);
}

/**
 * Promotes the freshest alias row to the canonical key, prunes legacy aliases,
 * and optionally patches the canonical entry under one accessor operation.
 */
export async function canonicalizeSessionEntryAliases(params: {
  agentId?: string;
  storePath: string;
  target: SessionLifecycleStoreTarget;
  update?: (
    entry: SessionEntry | undefined,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<CanonicalizeSessionEntryAliasesResult> {
  const store = Object.fromEntries(
    listSessionEntries({ agentId: params.agentId, storePath: params.storePath }).map(
      ({ sessionKey, entry }) => [sessionKey, entry],
    ),
  );
  const targetKeys = normalizeTargetStoreKeys(params.target);
  const freshest = resolveFreshestTargetEntry(store, targetKeys);
  const patch = params.update ? await params.update(cloneOptionalEntry(freshest?.entry)) : null;
  const entry = patch
    ? ({
        ...freshest?.entry,
        ...patch,
      } as SessionEntry)
    : cloneOptionalEntry(freshest?.entry);
  await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.storePath,
    removals: targetKeys
      .filter((key) => key !== params.target.canonicalKey)
      .map((sessionKey) => ({ sessionKey })),
    upserts: entry ? [{ sessionKey: params.target.canonicalKey, entry }] : undefined,
    skipMaintenance: true,
  });
  return {
    canonicalKey: params.target.canonicalKey,
    ...(entry ? { entry: cloneOptionalEntry(entry) } : {}),
  };
}

/**
 * Creates or updates one session entry and initializes its transcript header as
 * one SQLite-backed lifecycle operation. Callers do not compose row creation,
 * transcript initialization, rollback, and normalized session identity.
 */
export async function createSessionEntryWithTranscript<TError = string>(
  scope: SessionAccessScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  _options: SessionEntryCreateWithTranscriptOptions = {},
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const storePath = resolveAccessStorePath(scope);
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  const store = Object.fromEntries(
    listSessionEntries({ agentId, storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: scope.sessionKey });
  const created = await createEntry({
    existingEntry: resolved.existing ? { ...resolved.existing } : undefined,
    sessionEntries: cloneSessionEntries(store),
  });
  if (!created.ok) {
    return { ok: false, error: created.error, phase: "entry" };
  }

  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: created.entry.sessionId,
    storePath,
  });
  try {
    await appendSqliteTranscriptEvent(
      {
        agentId,
        sessionId: created.entry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
      },
      createSessionTranscriptHeader({ sessionId: created.entry.sessionId }),
    );
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
      phase: "transcript",
    };
  }

  const entry =
    created.entry.sessionFile === sessionFile
      ? created.entry
      : {
          ...created.entry,
          sessionFile,
        };
  await applySessionEntryLifecycleMutation({
    agentId,
    storePath,
    removals: resolved.legacyKeys.map((sessionKey) => ({ sessionKey })),
    upserts: [{ sessionKey: resolved.normalizedKey, entry }],
    skipMaintenance: true,
  });
  return { ok: true, entry, sessionFile };
}

export function cloneSessionEntries(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [sessionKey, { ...entry }]),
  );
}

function collectSessionEntryKeys(...entries: SessionEntry[]): Array<keyof SessionEntry> {
  const keys = new Set<keyof SessionEntry>();
  for (const entry of entries) {
    for (const key of Object.keys(entry) as Array<keyof SessionEntry>) {
      keys.add(key);
    }
  }
  return [...keys];
}

function sessionEntryFieldEqual(
  left: SessionEntry[keyof SessionEntry],
  right: SessionEntry[keyof SessionEntry],
): boolean {
  return Object.is(left, right) || isDeepStrictEqual(left, right);
}

function sessionEntryFieldUnset(
  hasValue: boolean,
  value: SessionEntry[keyof SessionEntry],
): boolean {
  return !hasValue || value === undefined;
}

function sessionEntryFieldUnchanged(params: {
  leftHasValue: boolean;
  leftValue: SessionEntry[keyof SessionEntry];
  rightHasValue: boolean;
  rightValue: SessionEntry[keyof SessionEntry];
}): boolean {
  const { leftHasValue, leftValue, rightHasValue, rightValue } = params;
  if (
    sessionEntryFieldUnset(leftHasValue, leftValue) &&
    sessionEntryFieldUnset(rightHasValue, rightValue)
  ) {
    return true;
  }
  return leftHasValue === rightHasValue && sessionEntryFieldEqual(leftValue, rightValue);
}

// Background activity can mutate non-identity fields after the initialization
// snapshot. Carry forward only same-session changes; the prepared entry still
// wins for any field it explicitly modified relative to the snapshot. This
// preserves heartbeat/delivery/context metadata without resurrecting fields that
// a reset intentionally cleared or carrying old-session metadata into /new.
export function mergeConcurrentReplySessionMetadata(params: {
  currentEntry: SessionEntry;
  preparedEntry: SessionEntry;
  snapshotEntry?: SessionEntry;
}): SessionEntry {
  const { currentEntry, preparedEntry, snapshotEntry } = params;
  if (!snapshotEntry || preparedEntry.sessionId !== snapshotEntry.sessionId) {
    return preparedEntry;
  }
  const merged: SessionEntry = { ...preparedEntry };
  const mergedFields = merged as Partial<
    Record<keyof SessionEntry, SessionEntry[keyof SessionEntry]>
  >;
  for (const key of collectSessionEntryKeys(currentEntry, preparedEntry, snapshotEntry)) {
    const currentHasValue = Object.hasOwn(currentEntry, key);
    const snapshotHasValue = Object.hasOwn(snapshotEntry, key);
    const preparedHasValue = Object.hasOwn(preparedEntry, key);
    const currentValue = currentEntry[key];
    const snapshotValue = snapshotEntry[key];
    const preparedValue = preparedEntry[key];
    const currentChanged = !sessionEntryFieldUnchanged({
      leftHasValue: currentHasValue,
      leftValue: currentValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    const preparedKeptSnapshot = sessionEntryFieldUnchanged({
      leftHasValue: preparedHasValue,
      leftValue: preparedValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    if (currentChanged && preparedKeptSnapshot) {
      if (currentHasValue) {
        mergedFields[key] = currentValue;
      } else {
        delete mergedFields[key];
      }
    }
  }
  return merged;
}

export function createReplySessionInitializationRevision(params: {
  entry: SessionEntry | undefined;
  storePath: string;
}): string {
  const { entry, storePath } = params;
  if (!entry) {
    return JSON.stringify(null);
  }
  // The guard only rejects a true session-identity rebind. Same-session
  // activity/context writes are merged below; comparing them here would reject
  // before the merge can preserve the concurrent metadata.
  const projected = projectSessionEntryForPersistenceRevision({ storePath, entry });
  const revisionEntry: Pick<SessionEntry, "sessionFile" | "sessionId"> = {
    sessionId: projected.sessionId,
  };
  if (projected.sessionFile !== undefined) {
    revisionEntry.sessionFile = projected.sessionFile;
  }
  return JSON.stringify(revisionEntry);
}

export function resolveInitializedReplySessionEntry(params: {
  agentId: string;
  currentEntry?: SessionEntry;
  sessionEntry: SessionEntry;
  storePath: string;
}): SessionEntry {
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: params.agentId,
    sessionId: params.sessionEntry.sessionId,
    storePath: params.storePath,
  });
  return {
    ...params.sessionEntry,
    sessionFile,
  };
}

/** Updates an existing entry only; returns null when the session is absent. */
export async function updateSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, update, options);
}

export type RecordInboundSessionMetaParams = {
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  /** Inbound message context whose stable metadata is derived and persisted. */
  ctx: MsgContext;
  /** Group routing resolution for group-owned session keys. */
  groupResolution?: GroupKeyResolution | null;
  /** Canonical or alias session key for the inbound conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type UpdateSessionLastRouteParams = {
  /** Account owning the delivery route when the channel is multi-account. */
  accountId?: string;
  /** Delivery channel id persisted as the last route channel. */
  channel?: SessionEntry["lastChannel"];
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  /** Optional inbound context whose session metadata is derived alongside the route. */
  ctx?: MsgContext;
  /** Explicit delivery context merged over the persisted session fallback. */
  deliveryContext?: DeliveryContext;
  /** Group routing resolution for group-owned session keys. */
  groupResolution?: GroupKeyResolution | null;
  /** Canonical channel route persisted as the session route slot. */
  route?: SessionEntry["route"];
  /** Canonical or alias session key for the routed conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Thread/topic id for the delivery route, when the transport has one. */
  threadId?: string | number;
  /** Delivery target persisted as the last route recipient. */
  to?: string;
};

/**
 * Records stable conversation metadata derived from one inbound message as a
 * single storage-sized upsert (createIfMissing by default). Inbound metadata
 * must not refresh activity timestamps — idle reset relies on updatedAt from
 * real session turns — so existing rows merge with preserve-activity
 * semantics while legacy alias keys collapse onto the canonical row.
 */
export async function recordInboundSessionMeta(
  params: RecordInboundSessionMetaParams,
): Promise<SessionEntry | null> {
  return await recordSqliteInboundSessionMeta(params);
}

/**
 * Persists the last known delivery route for one session as a single
 * storage-sized patch. Route updates preserve activity timestamps (#49515)
 * and merge explicit route/delivery input over the persisted session
 * fallback before normalizing the derived last* fields.
 */
export async function updateSessionLastRoute(
  params: UpdateSessionLastRouteParams,
): Promise<SessionEntry | null> {
  return await updateSqliteSessionLastRoute(params);
}

/** Resolves one abort target identity without exposing the mutable store. */
export function resolveSessionAbortTarget(
  scope: SessionAccessScope,
): SessionAbortTargetIdentity | null {
  const entry = loadSessionEntry(scope);
  if (!entry) {
    return null;
  }
  return {
    entry: { ...entry },
    sessionId: entry.sessionId,
    sessionKey: normalizeStoreSessionKey(scope.sessionKey),
  };
}

/**
 * Resolves, marks, touches, and canonicalizes one abort target entry as a
 * storage-sized operation. Runtime abort side effects remain with callers.
 */
export async function markSessionAbortTarget(params: {
  resolveAbortCutoff?: (context: SessionAbortTargetContext) => SessionAbortTargetCutoff | undefined;
  scope: SessionAccessScope;
  now?: () => number;
}): Promise<SessionAbortTargetResult | null> {
  let resolvedTarget: SessionAbortTargetResult | null = null;
  try {
    const sessionKey = normalizeStoreSessionKey(params.scope.sessionKey);
    const updated = await patchSessionEntry(
      params.scope,
      (currentEntry) => {
        resolvedTarget = {
          entry: { ...currentEntry },
          persisted: false,
          sessionId: currentEntry.sessionId,
          sessionKey,
        };
        const entry = {
          ...currentEntry,
          abortedLastRun: true,
          updatedAt: params.now?.() ?? Date.now(),
        };
        applySessionAbortCutoff(
          entry,
          params.resolveAbortCutoff?.({
            entry: { ...currentEntry },
            sessionKey,
          }),
        );
        return entry;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    return updated
      ? {
          entry: { ...updated },
          persisted: true,
          sessionId: updated.sessionId,
          sessionKey,
        }
      : null;
  } catch (error) {
    const fallbackTarget = resolvedTarget as unknown as SessionAbortTargetResult | null;
    if (fallbackTarget) {
      return {
        entry: fallbackTarget.entry,
        persisted: fallbackTarget.persisted,
        sessionId: fallbackTarget.sessionId,
        sessionKey: fallbackTarget.sessionKey,
        persistenceError: formatErrorMessage(error),
      };
    }
    throw error;
  }
}

function applySessionAbortCutoff(
  entry: Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">,
  cutoff: SessionAbortTargetCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}
