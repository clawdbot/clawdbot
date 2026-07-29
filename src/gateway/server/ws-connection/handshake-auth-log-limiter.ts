// Rate limiter for noisy websocket handshake auth logs.
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

/** Decision returned for a handshake auth log attempt. */
type HandshakeAuthLogDecision = {
  shouldLog: boolean;
  suppressedSinceLastLog: number;
};

type HandshakeAuthLogState = {
  lastLoggedAtMs: number;
  suppressedSinceLastLog: number;
};

/** Per-key log limiter that reports suppressed auth attempts on the next emitted log. */
export class HandshakeAuthLogLimiter {
  private readonly intervalMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, HandshakeAuthLogState>();

  constructor(options?: { intervalMs?: number; maxEntries?: number }) {
    this.intervalMs = resolveIntegerOption(options?.intervalMs, 30_000, { min: 1 });
    this.maxEntries = resolveIntegerOption(options?.maxEntries, 256, { min: 1 });
  }

  /** Register one auth event key and decide whether it should be logged now. */
  register(key: string, nowMs = Date.now()): HandshakeAuthLogDecision {
    const entry = this.entries.get(key);
    if (!entry) {
      this.pruneIfNeeded();
      this.entries.set(key, {
        lastLoggedAtMs: nowMs,
        suppressedSinceLastLog: 0,
      });
      return { shouldLog: true, suppressedSinceLastLog: 0 };
    }

    if (nowMs - entry.lastLoggedAtMs < this.intervalMs) {
      entry.suppressedSinceLastLog += 1;
      return { shouldLog: false, suppressedSinceLastLog: 0 };
    }

    const suppressedSinceLastLog = entry.suppressedSinceLastLog;
    entry.lastLoggedAtMs = nowMs;
    entry.suppressedSinceLastLog = 0;
    return { shouldLog: true, suppressedSinceLastLog };
  }

  private pruneIfNeeded(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

/** Build the limiter key from auth failure context. */
export function buildHandshakeAuthLogKey(params: {
  reason?: string;
  remoteAddr?: string;
  client?: string;
  mode?: string;
  authProvided?: string;
}): string {
  return [
    params.reason ?? "unknown",
    params.remoteAddr ?? "?",
    params.client ?? "?",
    params.mode ?? "?",
    params.authProvided ?? "?",
  ].join("|");
}

/** Return whether a missing-credential failure should use log rate limiting. */
export function shouldLimitMissingCredentialAuthLog(params: {
  reason?: string;
  authProvided?: string;
}): boolean {
  // Only no-credential retries are startup/config churn. Credential mismatches
  // and auth rate limits are security audit events and must log per attempt.
  return (
    params.authProvided === "none" &&
    (params.reason === "token_missing" || params.reason === "password_missing")
  );
}
