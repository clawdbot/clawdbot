// Owns Chrome MCP session creation, sharing, leasing, and shutdown.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { toErrorObject } from "../infra/errors.js";
import { createChromeMcpSession, waitForChromeMcpReady } from "./chrome-mcp-connect.js";
import type {
  ChromeMcpCallOptions,
  ChromeMcpOptionsInput,
  ChromeMcpProcessCleanupDeps,
  ChromeMcpSession,
  ChromeMcpSessionFactory,
  ChromeMcpSessionLease,
  PendingChromeMcpSession,
  PendingChromeMcpSessionLease,
} from "./chrome-mcp-contracts.js";
import { redactChromeMcpProfileLabelForDiagnostic } from "./chrome-mcp-diagnostics.js";
import {
  buildChromeMcpSessionCacheKey,
  cacheKeyMatchesProfileName,
  normalizeChromeMcpOptions,
} from "./chrome-mcp-options.js";
import {
  abortPendingChromeMcpSession,
  createSharedPendingChromeMcpSession,
  drainCancelledChromeMcpPendingSession,
  forgetCachedChromeMcpSessionIfCurrent,
  forgetPendingChromeMcpSessionIfCurrent,
  waitForSharedPendingChromeMcpSession,
} from "./chrome-mcp-pending.js";
import {
  closeTrackedChromeMcpSession,
  drainRetainedChromeMcpCleanup,
} from "./chrome-mcp-process.js";
import {
  pendingChromeMcpSessions as pendingSessions,
  retainedChromeMcpCleanupSessions as retainedCleanupSessions,
  setChromeMcpProcessCleanupDeps,
  setChromeMcpSessionFactory,
  chromeMcpSessions as sessions,
} from "./chrome-mcp-state.js";
import { BrowserProfileUnavailableError } from "./errors.js";

async function drainChromeMcpCleanupForKey(cacheKey: string): Promise<void> {
  const pending = pendingSessions.get(cacheKey);
  if (pending?.state.cancelled) {
    await drainCancelledChromeMcpPendingSession(pending);
  }
  await drainRetainedChromeMcpCleanup(cacheKey);
}

function hasChromeMcpCleanupForKey(cacheKey: string): boolean {
  return (
    pendingSessions.get(cacheKey)?.state.cancelled === true ||
    (retainedCleanupSessions.get(cacheKey)?.size ?? 0) > 0
  );
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
): Promise<boolean> {
  let closed = false;
  let firstError: Error | undefined;
  const keys = new Set([
    ...pendingSessions.keys(),
    ...sessions.keys(),
    ...retainedCleanupSessions.keys(),
  ]);
  for (const key of keys) {
    if (key === keepKey || !cacheKeyMatchesProfileName(key, profileName)) {
      continue;
    }
    closed = true;
    const pending = pendingSessions.get(key);
    if (pending) {
      abortPendingChromeMcpSession(pending, new Error("Chrome MCP profile session was replaced"));
      try {
        await drainCancelledChromeMcpPendingSession(pending);
      } catch (err) {
        firstError ??= toErrorObject(err, "Chrome MCP pending-session cleanup failed.");
        continue;
      }
    }
    try {
      await drainRetainedChromeMcpCleanup(key);
    } catch (err) {
      firstError ??= toErrorObject(err, "Chrome MCP retained-session cleanup failed.");
      continue;
    }
    const session = sessions.get(key);
    if (session) {
      sessions.delete(key);
      try {
        await closeTrackedChromeMcpSession(key, session);
      } catch (err) {
        firstError ??= toErrorObject(err, "Chrome MCP session cleanup failed.");
      }
    }
  }

  if (firstError) {
    throw firstError;
  }
  return closed;
}

async function getSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  signal?.throwIfAborted();
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);
  if (hasChromeMcpCleanupForKey(cacheKey)) {
    await drainChromeMcpCleanupForKey(cacheKey);
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  let staleReadySessionRetries = 0;
  for (;;) {
    let session = sessions.get(cacheKey);
    if (session && session.transport.pid === null) {
      sessions.delete(cacheKey);
      await closeTrackedChromeMcpSession(cacheKey, session);
      session = undefined;
    }

    let pendingLease: PendingChromeMcpSessionLease | undefined;
    let leasedPending: PendingChromeMcpSession | undefined;
    const pending = pendingSessions.get(cacheKey);
    if (pending?.state.cancelled) {
      await drainCancelledChromeMcpPendingSession(pending);
      continue;
    }
    if (pending) {
      leasedPending = pending;
      pendingLease = await waitForSharedPendingChromeMcpSession(pending, signal);
      session = pendingLease.session;
    }

    if (!session) {
      const createdPending = createSharedPendingChromeMcpSession(cacheKey, profileName, options);
      pendingSessions.set(cacheKey, createdPending);
      leasedPending = createdPending;
      pendingLease = await waitForSharedPendingChromeMcpSession(createdPending, signal);
      session = pendingLease.session;
    }

    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      if (session.transport.pid === null) {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        if (leasedPending) {
          forgetPendingChromeMcpSessionIfCurrent(cacheKey, leasedPending);
        }
        if (pendingLease) {
          await pendingLease.release(true);
          pendingLease = undefined;
        }
        staleReadySessionRetries += 1;
        if (staleReadySessionRetries > 1) {
          throw new BrowserProfileUnavailableError(
            `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". ` +
              "The Chrome MCP subprocess exited before it became usable.",
          );
        }
        continue;
      }
      return session;
    } catch (err) {
      if (signal?.aborted && pendingLease) {
        await pendingLease.release(true);
        pendingLease = undefined;
      } else if (pendingLease && leasedPending && leasedPending.state.waiters > 1) {
        await pendingLease.release(false);
        pendingLease = undefined;
      } else {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        if (leasedPending) {
          forgetPendingChromeMcpSessionIfCurrent(cacheKey, leasedPending);
        }
        if (pendingLease) {
          await pendingLease.release(true);
          pendingLease = undefined;
        } else {
          await closeTrackedChromeMcpSession(cacheKey, session);
        }
      }
      throw err;
    } finally {
      await pendingLease?.release(false);
    }
  }
}

async function getExistingSession(
  cacheKey: string,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  includePending = true,
): Promise<ChromeMcpSession | null> {
  if (!includePending && pendingSessions.has(cacheKey)) {
    return null;
  }

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    await closeTrackedChromeMcpSession(cacheKey, session);
    session = undefined;
  }

  const pending = pendingSessions.get(cacheKey);
  if (includePending && pending) {
    const pendingLease = await waitForSharedPendingChromeMcpSession(pending, signal);
    let pendingLeaseReleased = false;
    session = pendingLease.session;
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      if (session.transport.pid === null) {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        forgetPendingChromeMcpSessionIfCurrent(cacheKey, pending);
        await pendingLease.release(true);
        pendingLeaseReleased = true;
        return null;
      }
      return session;
    } catch (err) {
      if (signal?.aborted) {
        await pendingLease.release(true);
        pendingLeaseReleased = true;
      } else if (pending.state.waiters > 1) {
        await pendingLease.release(false);
        pendingLeaseReleased = true;
      } else {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        forgetPendingChromeMcpSessionIfCurrent(cacheKey, pending);
        await pendingLease.release(true);
        pendingLeaseReleased = true;
      }
      throw err;
    } finally {
      if (!pendingLeaseReleased) {
        await pendingLease.release(false);
      }
    }
  }

  if (session) {
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      return session;
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (forgetCachedChromeMcpSessionIfCurrent(cacheKey, session)) {
        await closeTrackedChromeMcpSession(cacheKey, session);
      }
      throw err;
    }
  }

  return null;
}

async function createEphemeralSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  signal?.throwIfAborted();
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  const creation = createChromeMcpSession(cacheKey, profileName, options, signal);
  let session: ChromeMcpSession | undefined;
  try {
    session = await creation.promise;
    await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
    return session;
  } catch (err) {
    await creation.cleanup;
    if (session) {
      await closeTrackedChromeMcpSession(cacheKey, session);
    }
    throw err;
  }
}

export async function leaseSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSessionLease> {
  options.signal?.throwIfAborted();
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, normalizedProfileOptions);
  if (!options.ephemeral) {
    return {
      session: await getSession(
        profileName,
        normalizedProfileOptions,
        options.timeoutMs,
        options.signal,
      ),
      cacheKey,
      temporary: false,
    };
  }

  if (hasChromeMcpCleanupForKey(cacheKey)) {
    await drainChromeMcpCleanupForKey(cacheKey);
  }
  options.signal?.throwIfAborted();
  // Status probes should avoid seeding the shared attach session cache, but they can safely
  // reuse a real cached session if one already exists.
  const existingSession = await getExistingSession(
    cacheKey,
    profileName,
    options.timeoutMs,
    options.signal,
    false,
  );
  if (existingSession) {
    return {
      session: existingSession,
      cacheKey,
      temporary: false,
    };
  }

  return {
    session: await createEphemeralSession(
      profileName,
      normalizedProfileOptions,
      options.timeoutMs,
      options.signal,
    ),
    cacheKey,
    temporary: true,
  };
}

async function stopAllChromeMcpSessions(): Promise<void> {
  const names = uniqueStrings(
    [...pendingSessions.keys(), ...sessions.keys(), ...retainedCleanupSessions.keys()].map(
      (key) => JSON.parse(key)[0] as string,
    ),
  );
  let firstError: Error | undefined;
  for (const name of names) {
    try {
      await closeChromeMcpSession(name);
    } catch (err) {
      firstError ??= toErrorObject(err, "Chrome MCP shutdown failed.");
    }
  }
  if (firstError) {
    throw firstError;
  }
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName);
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  setChromeMcpSessionFactory(factory);
}

/** Replace process cleanup hooks for focused tests. */
export function setChromeMcpProcessCleanupDepsForTest(
  deps: ChromeMcpProcessCleanupDeps | null,
): void {
  setChromeMcpProcessCleanupDeps(deps);
}

/** Reset cached sessions and test hooks. */
export async function resetChromeMcpSessionsForTest(): Promise<void> {
  setChromeMcpSessionFactory(null);
  for (const pending of pendingSessions.values()) {
    abortPendingChromeMcpSession(pending, new Error("Chrome MCP sessions reset for test"));
  }
  await Promise.allSettled(
    [...pendingSessions.values()].map(drainCancelledChromeMcpPendingSession),
  );
  await stopAllChromeMcpSessions();
  pendingSessions.clear();
  setChromeMcpProcessCleanupDeps(null);
}
