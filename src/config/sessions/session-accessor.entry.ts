import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import { resolveStorePath } from "./paths.js";
import { clearPluginOwnedSessionState } from "./plugin-host-cleanup.js";
import {
  listSqliteSessionEntries,
  loadExactSqliteSessionEntry,
  loadSqliteSessionEntry,
  patchSqliteSessionEntry,
  patchSqliteSessionEntryTarget,
  readSqliteSessionUpdatedAt,
  replaceSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
  upsertSqliteSessionEntry,
} from "./session-accessor.sqlite.js";
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
  ExactSessionEntry,
  SessionEntryPatchOptions,
  SessionEntryPatchContext,
  SessionEntryPatchResult,
  SessionEntryTargetPatchScope,
} from "./session-accessor.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveSessionStoreEntry } from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

export { clearPluginOwnedSessionState };

/** Keeps legacy store-key alias resolution behind the entry owner boundary. */
export function resolveSessionEntryFromStore(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): ReturnType<typeof resolveSessionStoreEntry> {
  return resolveSessionStoreEntry(params);
}

export function resolveAccessStorePath(scope: SessionAccessScope): string {
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: scope.env,
  });
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
    storePath: resolveStorePath(storeConfig, { agentId: params.agentId, env: params.env }),
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

function findFreshestSessionEntryMatch(
  entries: SessionEntrySummary[],
  candidateKeys: readonly string[],
): SessionEntrySummary | undefined {
  let freshest: SessionEntrySummary | undefined;
  for (const candidate of candidateKeys) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const match = entries.find((entry) => entry.sessionKey === trimmed);
    if (match && (!freshest || (match.entry.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) {
      freshest = match;
    }
  }
  return freshest;
}

/**
 * Resolves a logical session key to the freshest matching entry across the
 * configured store and discovered same-agent stores.
 */
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
  const storePath = resolveStorePath(scope.cfg.session?.store, {
    agentId: scope.agentId,
    env: scope.env,
  });
  const store = Object.fromEntries(
    listSessionEntries({ agentId: scope.agentId, storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  for (const candidateKey of uniqueStrings(scope.candidateKeys.map((key) => key.trim()))) {
    if (!candidateKey) {
      continue;
    }
    const resolved = resolveSessionEntryFromStore({ store, sessionKey: candidateKey });
    if (!resolved.existing) {
      continue;
    }
    return {
      agentId: scope.agentId,
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
    agentId: scope.agentId,
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
  const candidates = resolveLogicalSessionStoreCandidates({
    agentId,
    cfg: scope.cfg,
    env: scope.env,
  });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveStorePath(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findFreshestSessionEntryMatch(
    listSessionEntries({ agentId, storePath: fallback.storePath }),
    scanTargets,
  );
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findFreshestSessionEntryMatch(
      listSessionEntries({ agentId, storePath: candidate.storePath }),
      scanTargets,
    );
    if (
      match &&
      (!selectedMatch || (match.entry.updatedAt ?? 0) >= (selectedMatch.entry.updatedAt ?? 0))
    ) {
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
 * Mutates the freshest matching logical session entry without exposing the
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
  const updated = await patchSessionEntry(
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

/** Returns the entry for a canonical or alias session key, if one exists. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return loadSqliteSessionEntry(scope);
}

/**
 * Returns only the row persisted under the exact key provided.
 * Use this for authorization-sensitive routing where alias canonicalization
 * could cross an account or agent boundary.
 */
export function loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined {
  return loadExactSqliteSessionEntry(scope);
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntries(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  if (scope.clone === false) {
    return openSessionEntryReadView(scope).entries();
  }
  return listSqliteSessionEntries(scope);
}

/**
 * Borrowed keyed view over one resolved store for synchronous read-only hot paths.
 * Unlike loadSessionEntry, `get` is a raw exact persisted-key probe with no alias
 * or canonical-key resolution and no row scans, so large stores stay cheap until
 * `entries` is called. Rows are borrowed, not cloned: callers must not mutate them
 * and must drop the view before any await.
 */
export function openSessionEntryReadView(
  scope: Omit<SessionEntryListScope, "clone" | "readConsistency"> = {},
): SessionEntryReadView {
  // Exact-key probes read single SQLite rows; entries() materializes the full
  // list only when raw probes cannot settle the caller's lookup.
  return {
    get: (sessionKey) => loadExactSqliteSessionEntry({ ...scope, sessionKey })?.entry,
    entries: () => listSqliteSessionEntries(scope),
  };
}

/** Reads the last activity timestamp for one session entry, or undefined when absent. */
export function readSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  return readSqliteSessionUpdatedAt(scope);
}

/** Creates or updates one entry from a partial patch and returns the persisted entry. */
export async function upsertSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await upsertSqliteSessionEntry(scope, patch);
}

/** Replaces one entry with the supplied value and returns the persisted entry. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await replaceSqliteSessionEntry(scope, entry);
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  replaceSqliteSessionEntrySync(scope, entry);
}

/**
 * Applies an atomic patch to one entry.
 * The updater sees the current entry plus whether it was synthesized from a
 * fallback; returning null skips persistence.
 */
export async function patchSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, update, options);
}

/**
 * Applies an atomic patch to the freshest entry selected from a canonical key
 * plus its known aliases, then persists the result under the canonical key.
 */
export async function patchSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntryTarget(scope, update, options);
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
  const entry = await patchSqliteSessionEntry(scope, update, options);
  return entry ? { sessionKey: normalizeStoreSessionKey(scope.sessionKey), entry } : null;
}

/**
 * Copies one parent transcript into a new child transcript target.
 * This is for guarded callers that already own the eventual entry commit.
 */
