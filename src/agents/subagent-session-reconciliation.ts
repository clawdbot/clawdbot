/**
 * Subagent session-store reconciliation.
 *
 * Infers child completion from persisted session entries when registry updates arrive late.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export type SubagentSessionStoreCache = Map<string, Record<string, SessionEntry>>;
export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

/** Completion inferred from the child session store. */
export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

function finiteTimestamp(value: number | undefined): number | undefined {
  return asFiniteNumber(value);
}

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return finiteTimestamp(sessionEntry?.endedAt) ?? finiteTimestamp(sessionEntry?.updatedAt);
}

function isFreshForRun(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): boolean {
  if (notBeforeMs === undefined) {
    return true;
  }
  const terminalAt = terminalSessionTimestamp(sessionEntry);
  return terminalAt !== undefined && terminalAt >= notBeforeMs;
}

function freshSessionStartedAt(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): number | undefined {
  const startedAt = finiteTimestamp(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

function findSessionEntryByKey(store: Record<string, SessionEntry>, sessionKey: string) {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.trim().toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.trim().toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

/** Load a child session entry using the agent-specific session store path. */
export function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let store = params.storeCache?.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    params.storeCache?.set(storePath, store);
  }
  return findSessionEntryByKey(store, key);
}

/** Resolve a child session entry without depending on the file-backed store shape. */
function loadSubagentSessionEntryForAccessor(params: {
  childSessionKey: string;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return loadSessionEntry({
    storePath,
    sessionKey: key,
    clone: false,
  });
}

/** Resolves whether a registry row is orphaned from its child session entry. */
export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}): SubagentRunOrphanReason | null {
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  try {
    const sessionEntry = loadSubagentSessionEntryForAccessor({
      childSessionKey,
      cfg: params.cfg,
    });
    if (!sessionEntry) {
      return "missing-session-entry";
    }
    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }
    if (
      params.includeStaleUnended === true &&
      sessionEntry.abortedLastRun !== true &&
      isStaleUnendedSubagentRun(params.entry, params.now)
    ) {
      return "stale-unended-run";
    }
    return null;
  } catch {
    // Best-effort guard: avoid false orphan pruning on transient read/config failures.
    return null;
  }
}

/** Convert persisted session status into a subagent completion outcome. */
export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  const startedAt = freshSessionStartedAt(sessionEntry, opts?.notBeforeMs);
  const endedAt =
    finiteTimestamp(sessionEntry?.endedAt) ??
    finiteTimestamp(sessionEntry?.updatedAt) ??
    fallbackEndedAt;

  if (status === "done") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "timeout") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "failed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "session completed before registry settled" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
    };
  }
  if (status === "killed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "subagent run terminated" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
    };
  }
  if (status !== "running" && typeof sessionEntry?.endedAt === "number") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  return null;
}

/** Resolve child completion by reading its persisted session entry. */
export function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  return resolveCompletionFromSessionEntry(
    loadSubagentSessionEntry({
      childSessionKey: params.childSessionKey,
      storeCache: params.storeCache,
      cfg: params.cfg,
    }),
    params.fallbackEndedAt,
    { notBeforeMs: params.notBeforeMs },
  );
}

/** Resolve a fresh child session start time for lifecycle reconciliation. */
export function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): number | undefined {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    storeCache: params.storeCache,
    cfg: params.cfg,
  });
  return isFreshForRun(sessionEntry, params.notBeforeMs)
    ? freshSessionStartedAt(sessionEntry, params.notBeforeMs)
    : undefined;
}
