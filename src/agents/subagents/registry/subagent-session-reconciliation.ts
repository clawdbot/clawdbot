/**
 * Subagent session-store reconciliation.
 *
 * Infers child completion from persisted session entries when registry updates arrive late.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
  type SessionEntry,
} from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunOutcome } from "../announce/subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
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
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  let store = params.storeCache?.get(storePath);
  if (!store) {
    store = Object.fromEntries(
      listSessionEntriesReadOnly({ storePath, clone: false }).map(({ sessionKey, entry }) => [
        sessionKey,
        entry,
      ]),
    );
    params.storeCache?.set(storePath, store);
  }
  return store[key] ?? store[normalizeStoreSessionKey(key)];
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
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return loadSessionEntryReadOnly({
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

/**
 * Settle a registry row from its persisted child session entry.
 *
 * This is the only liveness re-observation available without a live agent run
 * context: the session store is written by the child itself, so a terminal
 * status there is authoritative stop evidence and a `running` status is
 * authoritative evidence that the child is still alive. Callers relying on that
 * must not first overwrite the entry with their own derived status.
 *
 * Returns what the child's own record says:
 * - `settled` — terminal there, so the stop is observed and this completion has
 *   been submitted through the ordinary lifecycle path.
 * - `live` — the entry exists and is still running. Terminal effects must not
 *   run against it.
 * - `absent` — no usable session entry, so there is nothing to reconcile from.
 *   This is the absence of evidence, not evidence of a stop: the entry is
 *   best-effort and also reads absent when the store is unreadable or has not
 *   been written yet. Callers deciding whether a child may still be alive must
 *   fail closed on it rather than treat it as `settled`.
 */
export async function settleSubagentRunFromSessionStore(
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    now: number;
    storeCache?: SubagentSessionStoreCache;
    source: string;
  },
): Promise<"settled" | "live" | "absent"> {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: args.entry.childSessionKey,
    storeCache: args.storeCache,
  });
  if (!sessionEntry) {
    return "absent";
  }
  const completion = resolveCompletionFromSessionEntry(sessionEntry, args.now, {
    notBeforeMs: args.entry.execution.startedAt ?? args.entry.createdAt,
  });
  if (!completion) {
    return "live";
  }
  await completeSubagentRunWithRecovery(
    {
      runId: args.runId,
      startedAt: completion.startedAt,
      endedAt: completion.endedAt,
      outcome: completion.outcome,
      reason: completion.reason,
      sendFarewell: true,
      accountId: args.entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    args.source,
  );
  return "settled";
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
