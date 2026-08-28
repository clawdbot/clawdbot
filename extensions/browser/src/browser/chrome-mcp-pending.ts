import { createChromeMcpSession, waitForChromeMcpPendingSession } from "./chrome-mcp-connect.js";
// Coordinates shared Chrome MCP session creation across concurrent waiters.
import type {
  ChromeMcpSession,
  NormalizedChromeMcpProfileOptions,
  PendingChromeMcpSession,
  PendingChromeMcpSessionLease,
} from "./chrome-mcp-contracts.js";
import {
  closeTrackedChromeMcpSession,
  drainRetainedChromeMcpCleanup,
} from "./chrome-mcp-process.js";
import {
  chromeMcpSessions as sessions,
  pendingChromeMcpSessions as pendingSessions,
} from "./chrome-mcp-state.js";

export function abortPendingChromeMcpSession(
  pending: PendingChromeMcpSession,
  reason: unknown = new Error("Chrome MCP session attach no longer has active waiters"),
): void {
  pending.state.cancelled = true;
  if (!pending.state.settled && !pending.abortController.signal.aborted) {
    pending.abortController.abort(reason);
  }
}

function forgetCancelledChromeMcpPendingSession(pending: PendingChromeMcpSession): void {
  if (pendingSessions.get(pending.cacheKey) === pending) {
    pendingSessions.delete(pending.cacheKey);
  }
}

export async function drainCancelledChromeMcpPendingSession(
  pending: PendingChromeMcpSession,
): Promise<void> {
  const cleanupWasSettled = pending.state.cleanupSettled;
  try {
    await pending.cleanup;
  } catch (err) {
    // All callers already waiting on the first attempt observe the same failure.
    // A later caller retries the retained exact handle before admitting a replacement.
    if (!cleanupWasSettled) {
      throw err;
    }
    await drainRetainedChromeMcpCleanup(pending.cacheKey);
  }
  forgetCancelledChromeMcpPendingSession(pending);
}

export function forgetCachedChromeMcpSessionIfCurrent(
  cacheKey: string,
  session: ChromeMcpSession,
): boolean {
  const current = sessions.get(cacheKey);
  if (current?.transport !== session.transport) {
    return false;
  }
  sessions.delete(cacheKey);
  return true;
}

export function forgetPendingChromeMcpSessionIfCurrent(
  cacheKey: string,
  pending: PendingChromeMcpSession,
): boolean {
  if (pendingSessions.get(cacheKey) !== pending) {
    return false;
  }
  pendingSessions.delete(cacheKey);
  return true;
}

export function createSharedPendingChromeMcpSession(
  cacheKey: string,
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): PendingChromeMcpSession {
  const id = Symbol(cacheKey);
  const abortController = new AbortController();
  const state: PendingChromeMcpSession["state"] = {
    waiters: 0,
    settled: false,
    cancelled: false,
    cleanupSettled: false,
  };
  const creation = createChromeMcpSession(cacheKey, profileName, options, abortController.signal);
  const promise = (async () => {
    try {
      const created = await creation.promise;
      state.session = created;
      if (pendingSessions.get(cacheKey)?.id === id) {
        sessions.set(cacheKey, created);
      } else {
        await closeTrackedChromeMcpSession(cacheKey, created);
      }
      return created;
    } finally {
      state.settled = true;
      if (!state.cancelled && state.waiters === 0 && pendingSessions.get(cacheKey)?.id === id) {
        pendingSessions.delete(cacheKey);
      }
    }
  })();
  const cleanup = creation.cleanup.finally(() => {
    state.cleanupSettled = true;
  });
  const pending: PendingChromeMcpSession = {
    cacheKey,
    id,
    promise,
    cleanup,
    abortController,
    state,
  };
  void promise.catch(() => {});
  void cleanup.catch(() => {});
  return pending;
}

export async function waitForSharedPendingChromeMcpSession(
  pending: PendingChromeMcpSession,
  signal?: AbortSignal,
): Promise<PendingChromeMcpSessionLease> {
  pending.state.waiters += 1;
  let released = false;
  let leasedSession: ChromeMcpSession | undefined;
  const release = async (closeIfLastWaiter: boolean) => {
    if (released) {
      return false;
    }
    released = true;
    pending.state.waiters = Math.max(0, pending.state.waiters - 1);
    if (pending.state.waiters !== 0) {
      return false;
    }
    if (!pending.state.settled) {
      abortPendingChromeMcpSession(pending, signal?.reason);
      await drainCancelledChromeMcpPendingSession(pending);
    } else if (closeIfLastWaiter) {
      const session = leasedSession ?? pending.state.session;
      if (session) {
        abortPendingChromeMcpSession(pending, signal?.reason);
        forgetCachedChromeMcpSessionIfCurrent(pending.cacheKey, session);
        await closeTrackedChromeMcpSession(pending.cacheKey, session);
      }
      forgetCancelledChromeMcpPendingSession(pending);
    } else {
      forgetPendingChromeMcpSessionIfCurrent(pending.cacheKey, pending);
    }
    return true;
  };
  let abortRelease: Promise<boolean> | undefined;
  const releaseOnAbort = () => {
    // Publish last-waiter cleanup synchronously inside the abort event. A new
    // caller must cross that barrier instead of adopting the cancelled attach.
    abortRelease ??= release(true);
    void abortRelease.catch(() => {});
  };
  signal?.addEventListener("abort", releaseOnAbort, { once: true });
  if (signal?.aborted) {
    releaseOnAbort();
  }
  try {
    leasedSession = await waitForChromeMcpPendingSession(pending.promise, signal);
    return {
      session: leasedSession,
      release,
    };
  } catch (err) {
    await (abortRelease ?? release(signal?.aborted === true));
    throw err;
  } finally {
    signal?.removeEventListener("abort", releaseOnAbort);
  }
}
