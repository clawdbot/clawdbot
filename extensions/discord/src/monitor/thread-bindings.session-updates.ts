import {
  normalizeNonNegativeMs,
  resolveBindingIdsForTargetSession,
  updateBindingsForTargetSession,
} from "./thread-bindings.session-shared.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

export function setThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    idleTimeoutMs,
    lastActivityAt: now,
  }));
}

export function setThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now,
  }));
}
