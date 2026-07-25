import { isDeepStrictEqual } from "node:util";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryRecord = Partial<Record<keyof SessionEntry, unknown>>;

export const SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

const MODEL_ROUTE_OVERRIDE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

const MODEL_OVERRIDE_RUNTIME_FIELDS = [
  "modelProvider",
  "model",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "contextTokens",
  "contextBudgetStatus",
] as const satisfies ReadonlyArray<keyof SessionEntry>;
const MODEL_OVERRIDE_RUNTIME_FIELD_SET = new Set<keyof SessionEntry>(MODEL_OVERRIDE_RUNTIME_FIELDS);

const MODEL_OVERRIDE_DEPENDENT_FIELDS = new Set<keyof SessionEntry>([
  ...MODEL_OVERRIDE_RUNTIME_FIELDS,
  "liveModelSwitchPending",
  "thinkingLevel",
]);

const MODEL_OVERRIDE_CONFLICT_DEPENDENT_FIELDS = ["thinkingLevel"] as const satisfies ReadonlyArray<
  keyof SessionEntry
>;

const MAIN_SESSION_RECOVERY_TRANSACTION_FIELDS = [
  "abortedLastRun",
  "restartRecoveryRuns",
  "mainRestartRecovery",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

function anySessionFieldChanged(
  before: SessionEntryRecord,
  after: SessionEntryRecord,
  fields: ReadonlyArray<keyof SessionEntry>,
): boolean {
  return fields.some((field) => !isDeepStrictEqual(before[field], after[field]));
}

function mainSessionRecoveryTransactionChanged(before: SessionEntry, after: SessionEntry): boolean {
  const beforeState = before.mainRestartRecovery;
  const afterState = after.mainRestartRecovery;
  return (
    before.abortedLastRun !== after.abortedLastRun ||
    !isDeepStrictEqual(before.restartRecoveryRuns, after.restartRecoveryRuns) ||
    beforeState?.cycleId !== afterState?.cycleId ||
    beforeState?.chargedAttempts !== afterState?.chargedAttempts ||
    !isDeepStrictEqual(beforeState?.reservation, afterState?.reservation) ||
    !isDeepStrictEqual(beforeState?.tombstone, afterState?.tombstone)
  );
}

function mainSessionRecoveryOwnershipChanged(before: SessionEntry, after: SessionEntry): boolean {
  return (
    before.mainRestartRecovery?.revision !== after.mainRestartRecovery?.revision ||
    !isDeepStrictEqual(
      before.mainRestartRecovery?.foregroundClaims,
      after.mainRestartRecovery?.foregroundClaims,
    )
  );
}

function mainSessionRecoveryCycleStateUnchanged(
  before: SessionEntry,
  after: SessionEntry,
): boolean {
  const beforeState = before.mainRestartRecovery;
  const afterState = after.mainRestartRecovery;
  if (!beforeState || !afterState) {
    return false;
  }
  return (
    beforeState.cycleId === afterState.cycleId &&
    beforeState.chargedAttempts === afterState.chargedAttempts &&
    isDeepStrictEqual(beforeState.reservation, afterState.reservation) &&
    isDeepStrictEqual(beforeState.tombstone, afterState.tombstone)
  );
}

function restartRecoveryRunsOnlyConsumed(before: SessionEntry, after: SessionEntry): boolean {
  const initialRuns = new Set(
    (before.restartRecoveryRuns ?? []).map((run) => `${run.runId}\u0000${run.lifecycleGeneration}`),
  );
  return (after.restartRecoveryRuns ?? []).every((run) =>
    initialRuns.has(`${run.runId}\u0000${run.lifecycleGeneration}`),
  );
}

function isCanonicalMainSessionRecoveryClear(entry: SessionEntry): boolean {
  return (
    entry.abortedLastRun === false &&
    entry.restartRecoveryRuns === undefined &&
    entry.mainRestartRecovery === undefined
  );
}

/** Projects run-local snapshot changes without restoring concurrently changed fields. */
export function projectSessionSnapshotChanges(params: {
  initial: SessionEntry;
  next: SessionEntry;
  current: SessionEntry;
  reassertAbortedLastRun?: boolean;
  reassertLiveModelSwitchPending?: boolean;
}): Partial<SessionEntry> {
  if (params.current.sessionId !== params.initial.sessionId) {
    return {};
  }
  const initial = params.initial as SessionEntryRecord;
  const next = params.next as SessionEntryRecord;
  const current = params.current as SessionEntryRecord;
  const patch: Partial<SessionEntry> = {};
  const patchRecord = patch as SessionEntryRecord;
  const fields = new Set<keyof SessionEntry>([
    ...(Object.keys(params.initial) as Array<keyof SessionEntry>),
    ...(Object.keys(params.next) as Array<keyof SessionEntry>),
  ]);

  const modelOverrideChanged = anySessionFieldChanged(
    initial,
    next,
    SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  );
  const modelRouteOverrideChanged = anySessionFieldChanged(
    initial,
    next,
    MODEL_ROUTE_OVERRIDE_FIELDS,
  );
  const modelOverrideChangedConcurrently = anySessionFieldChanged(
    initial,
    current,
    SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  );
  if (modelOverrideChanged && !modelOverrideChangedConcurrently) {
    // Model, provenance, and auth overrides form one selection transaction.
    // Project the whole family or none of it so concurrent switches cannot hybridize rows.
    for (const field of SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS) {
      patchRecord[field] = Object.hasOwn(params.next, field) ? next[field] : undefined;
    }
    if (modelRouteOverrideChanged) {
      // A winning route switch invalidates any runtime facts written for the
      // old model, including facts that appeared after this snapshot began.
      for (const field of MODEL_OVERRIDE_RUNTIME_FIELDS) {
        patchRecord[field] = Object.hasOwn(params.next, field) ? next[field] : undefined;
      }
    }
    for (const field of MODEL_OVERRIDE_DEPENDENT_FIELDS) {
      if (modelRouteOverrideChanged && MODEL_OVERRIDE_RUNTIME_FIELD_SET.has(field)) {
        continue;
      }
      if (!isDeepStrictEqual(initial[field], next[field])) {
        patchRecord[field] = Object.hasOwn(params.next, field) ? next[field] : undefined;
      }
    }
    if (params.reassertLiveModelSwitchPending) {
      // A second explicit switch can inherit true from the first snapshot while
      // the active runner concurrently clears it. Re-arm the winning transaction.
      patch.liveModelSwitchPending = true;
    }
  }

  const runtimeModelChanged =
    !isDeepStrictEqual(initial.model, next.model) ||
    !isDeepStrictEqual(initial.modelProvider, next.modelProvider);
  const runtimeModelChangedConcurrently =
    !isDeepStrictEqual(current.model, initial.model) ||
    !isDeepStrictEqual(current.modelProvider, initial.modelProvider);
  if (
    runtimeModelChanged &&
    !runtimeModelChangedConcurrently &&
    !modelOverrideChanged &&
    !modelOverrideChangedConcurrently
  ) {
    // Runtime model metadata is one pair. A model-only patch intentionally
    // clears provider state, so snapshot projection must emit both fields.
    patch.model = params.next.model;
    patch.modelProvider = params.next.modelProvider;
  }

  const mainRecoveryChanged = mainSessionRecoveryTransactionChanged(params.initial, params.next);
  const mainRecoveryChangedConcurrently = mainSessionRecoveryTransactionChanged(
    params.initial,
    params.current,
  );
  const mainRecoveryOwnershipChangedConcurrently = mainSessionRecoveryOwnershipChanged(
    params.initial,
    params.current,
  );
  const initialForegroundClaims = params.initial.mainRestartRecovery?.foregroundClaims;
  const currentForegroundClaims = params.current.mainRestartRecovery?.foregroundClaims;
  if (
    params.reassertAbortedLastRun &&
    params.next.abortedLastRun === true &&
    initialForegroundClaims &&
    currentForegroundClaims &&
    params.initial.mainRestartRecovery?.cycleId === params.current.mainRestartRecovery?.cycleId &&
    initialForegroundClaims.lifecycleGeneration === currentForegroundClaims.lifecycleGeneration
  ) {
    // A terminal abort is authoritative even when true matches this owner's
    // initial snapshot. Preserve the concurrently narrowed owner aggregate.
    patch.abortedLastRun = true;
  }
  const currentOnlyConsumedLifecycleFences =
    isCanonicalMainSessionRecoveryClear(params.next) &&
    !mainRecoveryOwnershipChangedConcurrently &&
    mainSessionRecoveryCycleStateUnchanged(params.initial, params.current) &&
    restartRecoveryRunsOnlyConsumed(params.initial, params.current);
  if (
    mainRecoveryChanged &&
    (!mainRecoveryChangedConcurrently || currentOnlyConsumedLifecycleFences)
  ) {
    // Apply all three fields together: a stale healthy flag can otherwise hide a newer marker.
    // A healthy run first marks its claim non-interrupted; token-scoped release
    // removes the aggregate only after the final concurrent owner exits.
    if (
      mainRecoveryOwnershipChangedConcurrently &&
      isCanonicalMainSessionRecoveryClear(params.next)
    ) {
      patch.abortedLastRun = false;
    } else if (!mainRecoveryOwnershipChangedConcurrently) {
      for (const field of MAIN_SESSION_RECOVERY_TRANSACTION_FIELDS) {
        patchRecord[field] = Object.hasOwn(params.next, field) ? next[field] : undefined;
      }
    }
  }

  for (const field of fields) {
    if (
      field === "model" ||
      field === "modelProvider" ||
      MAIN_SESSION_RECOVERY_TRANSACTION_FIELDS.includes(
        field as (typeof MAIN_SESSION_RECOVERY_TRANSACTION_FIELDS)[number],
      ) ||
      SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS.includes(
        field as (typeof SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS)[number],
      )
    ) {
      continue;
    }
    if (isDeepStrictEqual(initial[field], next[field])) {
      continue;
    }
    if (field === "updatedAt") {
      patch.updatedAt = Math.max(params.current.updatedAt, params.next.updatedAt);
      continue;
    }
    if (
      (modelOverrideChanged || modelOverrideChangedConcurrently) &&
      MODEL_OVERRIDE_DEPENDENT_FIELDS.has(field)
    ) {
      continue;
    }
    // The latest row wins conflicts. This prevents a stale run snapshot from
    // reviving policy or privacy fields cleared while the run was active.
    if (!isDeepStrictEqual(current[field], initial[field])) {
      continue;
    }
    patchRecord[field] = Object.hasOwn(params.next, field) ? next[field] : undefined;
  }
  return patch;
}

/** Reports whether every caller-owned snapshot delta is present in the current row. */
export function sessionSnapshotChangesApplied(params: {
  initial: SessionEntry;
  next: SessionEntry;
  current: SessionEntry;
  touchedFields?: ReadonlyArray<keyof SessionEntry>;
}): boolean {
  if (params.current.sessionId !== params.initial.sessionId) {
    return false;
  }
  const initial = params.initial as SessionEntryRecord;
  const next = params.next as SessionEntryRecord;
  const current = params.current as SessionEntryRecord;
  const fields = new Set<keyof SessionEntry>([
    ...(Object.keys(params.initial) as Array<keyof SessionEntry>),
    ...(Object.keys(params.next) as Array<keyof SessionEntry>),
    ...(params.touchedFields ?? []),
  ]);
  fields.delete("updatedAt");
  for (const field of fields) {
    const explicitlyTouched = params.touchedFields?.includes(field) === true;
    if (
      (explicitlyTouched || !isDeepStrictEqual(initial[field], next[field])) &&
      !isDeepStrictEqual(current[field], next[field])
    ) {
      return false;
    }
  }
  return true;
}

/** Reports an explicit grouped-write conflict before any snapshot fields are committed. */
export function sessionSnapshotTouchedFieldsConflict(params: {
  initial: SessionEntry;
  next: SessionEntry;
  current: SessionEntry;
  touchedFields?: ReadonlyArray<keyof SessionEntry>;
}): boolean {
  if (params.current.sessionId !== params.initial.sessionId) {
    return true;
  }
  const initial = params.initial as SessionEntryRecord;
  const next = params.next as SessionEntryRecord;
  const current = params.current as SessionEntryRecord;
  const fields = new Set(params.touchedFields ?? []);
  if (SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS.some((field) => fields.has(field))) {
    for (const field of MODEL_OVERRIDE_CONFLICT_DEPENDENT_FIELDS) {
      if (!isDeepStrictEqual(initial[field], next[field])) {
        fields.add(field);
      }
    }
  }
  return [...fields].some(
    (field) =>
      !isDeepStrictEqual(current[field], initial[field]) &&
      !isDeepStrictEqual(current[field], next[field]),
  );
}

/** Replaces a caller-held snapshot with the latest persisted row in place. */
export function adoptPersistedSessionSnapshot(target: SessionEntry, current: SessionEntry): void {
  const targetRecord = target as SessionEntryRecord;
  const currentRecord = current as SessionEntryRecord;
  for (const field of Object.keys(target) as Array<keyof SessionEntry>) {
    if (!Object.hasOwn(current, field)) {
      delete targetRecord[field];
    }
  }
  for (const field of Object.keys(current) as Array<keyof SessionEntry>) {
    targetRecord[field] = currentRecord[field];
  }
}

/** Reports whether a model/auth selection transaction is the persisted winner. */
export function sessionModelOverrideChangesApplied(params: {
  initial: SessionEntry;
  next: SessionEntry;
  current: SessionEntry;
  reassertLiveModelSwitchPending?: boolean;
}): boolean {
  if (params.current.sessionId !== params.initial.sessionId) {
    return false;
  }
  const next = params.next as SessionEntryRecord;
  const current = params.current as SessionEntryRecord;
  const initial = params.initial as SessionEntryRecord;
  const changedDependentFields = [...MODEL_OVERRIDE_DEPENDENT_FIELDS].filter(
    (field) => !isDeepStrictEqual(initial[field], next[field]),
  );
  const modelRouteOverrideChanged = anySessionFieldChanged(
    initial,
    next,
    MODEL_ROUTE_OVERRIDE_FIELDS,
  );
  const fields = [
    ...SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
    ...(modelRouteOverrideChanged ? MODEL_OVERRIDE_RUNTIME_FIELDS : []),
    ...changedDependentFields,
  ];
  if (fields.some((field) => !isDeepStrictEqual(current[field], next[field]))) {
    return false;
  }
  return !params.reassertLiveModelSwitchPending || params.current.liveModelSwitchPending === true;
}

/** Merges run-local snapshot changes into the latest persisted session row. */
export function mergeSessionSnapshotChanges(params: {
  initial: SessionEntry;
  next: SessionEntry;
  current: SessionEntry;
  reassertAbortedLastRun?: boolean;
  reassertLiveModelSwitchPending?: boolean;
}): SessionEntry {
  const merged = { ...params.current };
  const mergedRecord = merged as SessionEntryRecord;
  const patch = projectSessionSnapshotChanges(params) as SessionEntryRecord;
  for (const field of Object.keys(patch) as Array<keyof SessionEntry>) {
    if (patch[field] === undefined) {
      delete mergedRecord[field];
    } else {
      mergedRecord[field] = patch[field];
    }
  }
  return merged;
}
