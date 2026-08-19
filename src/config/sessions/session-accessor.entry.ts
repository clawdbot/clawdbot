import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { clearPluginOwnedSessionState } from "./plugin-host-cleanup.js";
import {
  copySqliteSessionOwnedStateForCanonicalRepair as copySessionOwnedStateForCanonicalRepair,
  ensureSqliteTranscriptGenerationsForCanonicalRepair as ensureTranscriptGenerationsForCanonicalRepair,
  listSqliteSessionEntriesForCanonicalRepair as listSessionEntriesForCanonicalRepair,
  listSqliteSessionGenerationIdsForCanonicalRepair as listSessionGenerationIdsForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepair as rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch as rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
} from "./session-accessor.sqlite-canonical-repair.js";
import {
  countSessionEntryRowsReadOnly,
  ensureSessionEntrySync,
  hasSessionEntriesByStatusReadOnly,
  listSessionChildEntriesReadOnly,
  listSessionEntryRows,
  listSessionEntriesReadOnly,
  listSessionEntryKeysReadOnly,
  loadExactSessionEntry,
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
  resolveSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import type {
  SessionAccessScope,
  LogicalSessionAccessScope,
  SessionEntryListScope,
  ResolvedSessionEntryAccessTarget,
  ResolvedSessionEntryStoreTarget,
  SessionEntryCandidateAccessScope,
  ResolvedSessionEntryCandidateTarget,
  ResolvedSessionEntryUpdateContext,
  ResolvedSessionEntryUpdateResult,
  SessionEntrySummary,
  SessionEntryReadView,
  SessionEntryPatchOptions,
  SessionEntryPatchContext,
  SessionEntryPatchResult,
} from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  normalizeStoreSessionKey,
  resolveSessionStoreEntryCore as resolveSessionEntryFromStore,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export { clearPluginOwnedSessionState };

// SQLite is the only runtime session store. Re-export its canonical entry operations directly.
export {
  countSessionEntryRowsReadOnly,
  copySessionOwnedStateForCanonicalRepair,
  ensureTranscriptGenerationsForCanonicalRepair,
  ensureSessionEntrySync,
  hasSessionEntriesByStatusReadOnly,
  listSessionGenerationIdsForCanonicalRepair,
  listSessionChildEntriesReadOnly,
  listSessionEntriesReadOnly,
  listSessionEntriesForCanonicalRepair,
  rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
  listSessionEntryKeysReadOnly,
  loadExactSessionEntry,
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  // Intentionally unfenced: branching owns session-identity freshness; worker transcript commit
  // fresh-reads and checks sessionId inside its locked commit, and void/entry has no rebound signal.
  replaceSessionEntrySync,
  resolveSessionEntryFromStore,
  upsertSessionEntryCore,
};

/** Resolves a session directly through canonical SQLite row and alias ownership. */
export function resolveSessionEntrySelection(
  scope: SessionAccessScope,
  options: { readOnly?: boolean } = {},
): ReturnType<typeof resolveSessionEntryFromStore> {
  return resolveSessionEntry(scope, options);
}

export function resolveAccessStorePath(scope: SessionAccessScope): string {
  return resolveSessionStorePathForScope(scope);
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function resolveLogicalSessionStoreCandidates(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[] {
  const storeConfig = params.cfg.session?.store;
  const defaultTarget = {
    agentId: params.agentId,
    storePath: resolveSessionStorePathCore(storeConfig, {
      agentId: params.agentId,
      env: params.env,
    }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    if (target.agentId === params.agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function buildLogicalSessionEntryCandidateKeys(params: {
  agentId: string;
  canonicalKey: string;
  cfg: OpenClawConfig;
  requestedKey: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.requestedKey && params.requestedKey !== params.canonicalKey) {
    targets.add(params.requestedKey);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function findCanonicalSessionEntryMatch(
  scope: Omit<SessionAccessScope, "sessionKey">,
  canonicalKey: string,
  candidateKeys: readonly string[],
  options: { readOnly?: boolean } = {},
): SessionEntrySummary | undefined {
  let selected: SessionEntrySummary | undefined;
  for (const candidate of candidateKeys) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const loadExact =
      options.readOnly === false ? loadExactSessionEntry : loadExactSessionEntryReadOnly;
    const match = loadExact({ ...scope, sessionKey: trimmed });
    if (!match) {
      continue;
    }
    if (selected) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
    }
    if (match.sessionKey !== canonicalKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    }
    selected = match;
  }
  return selected;
}

/** Resolves one canonical row across the prepared configured and discovered store targets. */
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryAccessTarget {
  const target = resolveSessionEntryStoreTarget(scope);
  return {
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    entry: target.entry,
    requestedKey: target.requestedKey,
    storeKey: target.storeKey,
  };
}

/** Resolves ordered candidate keys inside one agent-owned session store. */
export function resolveSessionEntryCandidateTarget(
  scope: SessionEntryCandidateAccessScope,
): ResolvedSessionEntryCandidateTarget | null {
  const candidateKeys = uniqueStrings(scope.candidateKeys.map((key) => key.trim()));
  const incognitoKey = candidateKeys.find(isIncognitoSessionKey);
  const incognitoAgentId = incognitoKey ? resolveAgentIdFromSessionKey(incognitoKey) : undefined;
  const storePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : resolveSessionStorePathCore(scope.cfg.session?.store, {
        agentId: scope.agentId,
        env: scope.env,
      });
  const resolvedAgentId = incognitoAgentId ?? scope.agentId;
  for (const candidateKey of candidateKeys) {
    if (!candidateKey) {
      continue;
    }
    const resolved = resolveSessionEntrySelection(
      {
        agentId: resolvedAgentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionKey: candidateKey,
        storePath,
      },
      { readOnly: !incognitoAgentId },
    );
    if (!resolved.existing) {
      continue;
    }
    return {
      agentId: resolvedAgentId,
      candidateKey,
      entry: structuredClone(resolved.existing),
      persisted: true,
      sessionKey: resolved.normalizedKey,
    };
  }
  const fallbackKey = scope.fallback?.sessionKey.trim();
  if (!fallbackKey || !scope.fallback) {
    return null;
  }
  return {
    agentId: resolvedAgentId,
    candidateKey: fallbackKey,
    entry: structuredClone(scope.fallback.entry),
    persisted: false,
    sessionKey: fallbackKey,
  };
}

function resolveSessionEntryStoreTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryStoreTarget {
  const requestedKey = scope.sessionKey.trim();
  const canonicalKey = resolveSessionStoreKey({ cfg: scope.cfg, sessionKey: requestedKey });
  const agentId = resolveSessionStoreAgentId(scope.cfg, canonicalKey);
  const scanTargets = buildLogicalSessionEntryCandidateKeys({
    agentId,
    canonicalKey,
    cfg: scope.cfg,
    requestedKey,
  });
  if (isIncognitoSessionKey(canonicalKey)) {
    const incognitoAgentId = resolveAgentIdFromSessionKey(canonicalKey);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: incognitoAgentId,
      env: scope.env,
    });
    const selectedMatch = findCanonicalSessionEntryMatch(
      { agentId: incognitoAgentId, ...(scope.env ? { env: scope.env } : {}), storePath },
      canonicalKey,
      scanTargets,
      { readOnly: false },
    );
    return {
      agentId: incognitoAgentId,
      canonicalKey,
      entry: selectedMatch?.entry,
      requestedKey,
      storeKey: selectedMatch?.sessionKey ?? canonicalKey,
      storePath,
    };
  }
  const candidates = resolveLogicalSessionStoreCandidates({
    agentId,
    cfg: scope.cfg,
    env: scope.env,
  });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveSessionStorePathCore(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findCanonicalSessionEntryMatch(
    { agentId, ...(scope.env ? { env: scope.env } : {}), storePath: fallback.storePath },
    canonicalKey,
    scanTargets,
  );
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findCanonicalSessionEntryMatch(
      { agentId, ...(scope.env ? { env: scope.env } : {}), storePath: candidate.storePath },
      canonicalKey,
      scanTargets,
    );
    if (match && selectedMatch) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
    }
    if (match) {
      selectedStorePath = candidate.storePath;
      selectedMatch = match;
    }
  }
  return {
    agentId,
    canonicalKey,
    entry: selectedMatch?.entry,
    requestedKey,
    storeKey: selectedMatch?.sessionKey ?? canonicalKey,
    storePath: selectedStorePath,
  };
}

/**
 * Mutates the canonical logical session entry without exposing the
 * backing store map to callers.
 */
export async function updateResolvedSessionEntry<T>(
  scope: LogicalSessionAccessScope,
  update: (entry: SessionEntry, context: ResolvedSessionEntryUpdateContext) => Promise<T> | T,
): Promise<ResolvedSessionEntryUpdateResult<T>> {
  const target = resolveSessionEntryStoreTarget(scope);
  if (!target.entry) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  let updateResult: T | undefined;
  const updated = await patchSessionEntryCore(
    { sessionKey: target.storeKey, storePath: target.storePath },
    async (entry) => {
      const context: ResolvedSessionEntryUpdateContext = {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry,
        requestedKey: target.requestedKey,
        storeKey: target.storeKey,
      };
      updateResult = await update(entry, context);
      return entry;
    },
    {
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
  if (!updated) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  return {
    canonicalKey: target.canonicalKey,
    entry: structuredClone(updated),
    found: true,
    result: updateResult as T,
    storeKey: target.storeKey,
  };
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntriesCore(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  if (scope.clone === false) {
    return openSessionEntryReadView(scope).entries();
  }
  return listSessionEntryRows(scope);
}

/**
 * Borrowed keyed view over one resolved store for synchronous read-only hot paths.
 * Unlike loadSessionEntry, `get` is a raw exact persisted-key probe with no alias
 * or canonical-key resolution. The first probe materializes one validated store
 * snapshot; later probes and `entries` reuse its parsed rows. Rows are borrowed,
 * not cloned: callers must not mutate them and must drop the view before any await.
 */
export function openSessionEntryReadView(
  scope: Omit<SessionEntryListScope, "clone" | "readConsistency"> = {},
): SessionEntryReadView {
  return {
    get: (sessionKey) =>
      (isIncognitoSessionKey(sessionKey) ? loadExactSessionEntry : loadExactSessionEntryReadOnly)({
        ...scope,
        clone: false,
        sessionKey,
      })?.entry,
    entries: () => listSessionEntryRows({ ...scope, clone: false }),
  };
}

/**
 * Applies an atomic patch and returns the persisted key selected by the backing
 * store. Use when a caller must keep sidecar state keyed to the final row.
 */
export async function patchSessionEntryWithKey(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntryPatchResult | null> {
  const entry = await patchSessionEntryCore(scope, update, options);
  return entry ? { sessionKey: normalizeStoreSessionKey(scope.sessionKey), entry } : null;
}

/**
 * Copies one parent transcript into a new child transcript target.
 * This is for guarded callers that already own the eventual entry commit.
 */
