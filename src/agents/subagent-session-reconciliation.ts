import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";

export type SubagentSessionStoreCache = Map<string, Record<string, SessionEntry>>;

export type SubagentSessionCompletion = {
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  const endedAt =
    finiteTimestamp(sessionEntry?.endedAt) ??
    finiteTimestamp(sessionEntry?.updatedAt) ??
    fallbackEndedAt;

  if (status === "done") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
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
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  return null;
}

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
