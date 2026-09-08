/**
 * Process-local registry that lets Talk protocol methods resolve opaque
 * `sessionId` values to the concrete relay or managed-room backend.
 */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { formatError } from "./server-utils.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";

type TalkConnectionCleanupKind = "browser-control" | "realtime-relay" | "transcription-relay";

type UnifiedTalkSessionRecord =
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
      sessionTarget: PreparedTalkSessionTarget;
    }
  | {
      kind: "transcription-relay";
      connId: string;
      transcriptionSessionId: string;
    }
  | {
      kind: "managed-room";
      handoffId: string;
      token: string;
      roomId: string;
    };

const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);
type TalkConnectionCleanup = {
  run: () => void | Promise<void>;
  nextRun?: () => void | Promise<void>;
  pending?: Promise<void>;
  failed: boolean;
};

const talkConnectionCleanups = resolveGlobalMap<
  string,
  Map<TalkConnectionCleanupKind, TalkConnectionCleanup>
>(
  Symbol.for("openclaw.talkConnectionCleanups"),
  async (connections) => {
    const results = await Promise.allSettled(
      [...connections].flatMap(([connId, cleanups]) =>
        [...cleanups].map(async ([kind, cleanup]) => {
          await runTalkConnectionCleanup(connId, kind, cleanup);
        }),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Talk provider cleanup did not complete");
    }
  },
  "close-and-restart",
);

function runTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: TalkConnectionCleanup,
): void | Promise<void> {
  if (cleanup.pending) {
    return cleanup.pending;
  }
  if (talkConnectionCleanups.get(connId)?.get(kind) !== cleanup) {
    return;
  }
  // A cleanup callback can reenter shutdown before returning its own promise.
  const completion = createDeferredCore();
  cleanup.pending = completion.promise;
  const completed = (): void | Promise<void> => {
    cleanup.pending = undefined;
    cleanup.failed = false;
    const cleanups = talkConnectionCleanups.get(connId);
    if (cleanups?.get(kind) === cleanup) {
      if (cleanup.nextRun) {
        cleanup.run = cleanup.nextRun;
        cleanup.nextRun = undefined;
        return runTalkConnectionCleanup(connId, kind, cleanup);
      }
      cleanups.delete(kind);
      if (cleanups.size === 0 && talkConnectionCleanups.get(connId) === cleanups) {
        talkConnectionCleanups.delete(connId);
      }
    }
  };
  const failed = (error: unknown): never => {
    cleanup.pending = undefined;
    cleanup.failed = true;
    throw error;
  };
  try {
    const run = cleanup.run;
    const result = run();
    if (isPromiseLike(result)) {
      completion.resolve(Promise.resolve(result).then(completed, failed));
      return completion.promise;
    }
    const next = completed();
    completion.resolve(next);
    return next;
  } catch (error) {
    completion.reject(error);
    // The caller observes the synchronous throw; a reentrant drain may also join this promise.
    void completion.promise.catch(() => {});
    return failed(error);
  }
}

/** Keeps failed cleanup under its original owner until a successful retry. */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: () => void | Promise<void>,
): void {
  const cleanups =
    talkConnectionCleanups.get(connId) ??
    new Map<TalkConnectionCleanupKind, TalkConnectionCleanup>();
  const previous = cleanups.get(kind);
  // Each kind scans its live sessions; retain a failed original before the latest replacement.
  if (previous?.pending || previous?.failed) {
    previous.nextRun = cleanup;
  } else {
    cleanups.set(kind, { run: cleanup, failed: false });
  }
  talkConnectionCleanups.set(connId, cleanups);
}

/** Starts cleanup without blocking the socket callback and reports asynchronous failures. */
export function cleanupTalkConnection(
  connId: string,
  log: { warn: (message: string) => void },
): void {
  const cleanups = talkConnectionCleanups.get(connId);
  if (!cleanups) {
    return;
  }
  // Snapshot owners because callbacks can remove or replace cleanup kinds.
  const snapshot = [...cleanups];
  for (const [kind, cleanup] of snapshot) {
    if (cleanup.pending) {
      continue;
    }
    const report = (error: unknown) => {
      log.warn(
        `failed to run ${kind} Talk cleanup after connection disconnect: ${formatError(error)}`,
      );
    };
    try {
      const pending = runTalkConnectionCleanup(connId, kind, cleanup);
      if (pending) {
        void pending.catch(report);
      }
    } catch (error) {
      report(error);
    }
  }
}

/** Associates a public Talk session id with its concrete gateway backend. */
export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

/** Resolves a Talk session id or throws the protocol-facing unknown-session error. */
export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Retains the realtime relay's admitted target without reinterpreting current defaults. */
export function resolveUnifiedTalkSessionTarget(sessionId: string, connId: string | undefined) {
  const session = unifiedTalkSessions.get(sessionId);
  if (session?.kind !== "realtime-relay") {
    return undefined;
  }
  requireUnifiedTalkSessionConn(session, connId);
  const target = session.sessionTarget;
  return {
    target,
    isCurrent: () =>
      unifiedTalkSessions.get(sessionId) === session &&
      session.connId === connId &&
      session.sessionTarget === target,
  };
}

/** Removes a Talk session id after the concrete backend closes. */
export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Enforces that a relay-backed Talk session is controlled by its owner socket. */
export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}
