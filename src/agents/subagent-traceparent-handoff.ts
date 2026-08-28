import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeDiagnosticTraceparent } from "../infra/diagnostic-trace-context-pure.js";

const SUBAGENT_TRACEPARENT_HANDOFF_TTL_MS = 5 * 60 * 1000;

type SubagentTraceparentHandoff = {
  idempotencyKey: string;
  sessionKey: string;
  traceparent: string;
};

type SubagentTraceparentHandoffEntry = SubagentTraceparentHandoff & {
  expiresAtMs: number;
};

const traceparentHandoffs = new Map<string, SubagentTraceparentHandoffEntry>();

function handoffKey(params: { idempotencyKey: string; sessionKey: string }): string {
  return `${params.idempotencyKey}\0${params.sessionKey}`;
}

function pruneExpiredSubagentTraceparentHandoffs(nowMs: number): void {
  for (const [key, entry] of traceparentHandoffs) {
    if (entry.expiresAtMs <= nowMs) {
      traceparentHandoffs.delete(key);
    }
  }
}

export function registerSubagentTraceparentHandoff(params: {
  idempotencyKey: string;
  sessionKey: string;
  traceparent?: string;
  nowMs?: number;
}): SubagentTraceparentHandoff | undefined {
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const traceparent = normalizeDiagnosticTraceparent(params.traceparent);
  if (!idempotencyKey || !sessionKey || !traceparent) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredSubagentTraceparentHandoffs(nowMs);
  const handoff: SubagentTraceparentHandoff = {
    idempotencyKey,
    sessionKey,
    traceparent,
  };
  traceparentHandoffs.set(handoffKey(handoff), {
    ...handoff,
    expiresAtMs: nowMs + SUBAGENT_TRACEPARENT_HANDOFF_TTL_MS,
  });
  return handoff;
}

export function consumeSubagentTraceparentHandoff(params: {
  idempotencyKey?: string;
  sessionKey?: string;
  nowMs?: number;
}): SubagentTraceparentHandoff | undefined {
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!idempotencyKey || !sessionKey) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredSubagentTraceparentHandoffs(nowMs);
  const key = handoffKey({ idempotencyKey, sessionKey });
  const entry = traceparentHandoffs.get(key);
  if (!entry) {
    return undefined;
  }
  traceparentHandoffs.delete(key);
  if (entry.expiresAtMs <= nowMs) {
    return undefined;
  }
  return {
    idempotencyKey: entry.idempotencyKey,
    sessionKey: entry.sessionKey,
    traceparent: entry.traceparent,
  };
}

export function resetSubagentTraceparentHandoffsForTests(): void {
  traceparentHandoffs.clear();
}
