// Source text for the long-lived cross-process concurrency worker. Split out of
// session-accessor.reply-init-concurrency.test-support.ts to keep that file under the
// repo's line limit; the harness that spawns and drives this worker stays there.
// The builder interpolates only the shared SESSION_KEY / AGENT_ID constants and the two
// dynamic-import URLs, so the emitted script has no other host-scope dependencies.

export const SESSION_KEY = "agent:main:main";
export const AGENT_ID = "main";

export function createConcurrencyWorkerScript(
  sessionAccessorUrl: string,
  sessionManagerUrl: string,
): string {
  return `
const {
  appendTranscriptMessageSync,
  appendTranscriptMessageWithSnapshotSync,
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  loadTranscriptEventsWithRowSnapshotSync,
  replaceTranscriptEventsSync,
  replaceTranscriptEventsWithSnapshotSync,
  SqliteTranscriptMutationConflictError,
  withTranscriptWriteLock,
} = await import(${JSON.stringify(sessionAccessorUrl)});
const { SessionManager } = await import(${JSON.stringify(sessionManagerUrl)});

const SESSION_KEY = ${JSON.stringify(SESSION_KEY)};
const AGENT_ID = ${JSON.stringify(AGENT_ID)};
const proceedResolvers = new Map();

function send(message) {
  process.send?.(message);
}

function waitForProceed(requestId) {
  return new Promise((resolve) => {
    proceedResolvers.set(requestId, resolve);
  });
}

async function runReplyInit(request) {
  const snapshot = loadReplySessionInitializationSnapshot({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    storePath: request.storePath,
  });
  const proceed = waitForProceed(request.requestId);
  send({
    phase: "ready",
    requestId: request.requestId,
    value: {
      currentEntry: snapshot.currentEntry,
      revision: snapshot.revision,
    },
  });
  await proceed;
  return commitReplySessionInitialization({
    activeSessionKey: SESSION_KEY,
    agentId: AGENT_ID,
    expectedRevision: snapshot.revision,
    sessionEntry: {
      sessionId: "existing-session",
      updatedAt: request.preparedUpdatedAt,
    },
    sessionKey: SESSION_KEY,
    snapshotEntry: snapshot.currentEntry,
    storePath: request.storePath,
  });
}

async function runTranscriptRewrite(request) {
  let result;
  try {
    await withTranscriptWriteLock(
      {
        agentId: AGENT_ID,
        sessionId: request.sessionId,
        sessionKey: SESSION_KEY,
        storePath: request.storePath,
      },
      async (transcript) => {
        if (request.rewriteMode === "replace-twice") {
          const firstReplacement = [
            { type: "session", version: 3, id: request.sessionId },
            {
              type: "message",
              id: "first-replacement",
              parentId: null,
              message: { role: "assistant", content: "first replacement" },
            },
          ];
          await transcript.replaceEvents(firstReplacement);
          const proceed = waitForProceed(request.requestId);
          send({
            phase: "ready",
            requestId: request.requestId,
            value: { eventCount: firstReplacement.length },
          });
          await proceed;
          await transcript.replaceEvents([
            firstReplacement[0],
            {
              type: "message",
              id: "first-replacement",
              parentId: null,
              message: { role: "assistant", content: "second replacement" },
            },
          ]);
          return;
        }
        const events = await transcript.readEvents();
        const proceed = waitForProceed(request.requestId);
        send({
          phase: "ready",
          requestId: request.requestId,
          value: { eventCount: events.length },
        });
        await proceed;
        const rewrittenEvents = events.map((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event) ||
            event.id !== "rewrite-target"
          ) {
            return event;
          }
          return {
            ...event,
            message: {
              ...event.message,
              content: "rewritten content",
            },
          };
        });
        await transcript.replaceEvents(rewrittenEvents);
      },
    );
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function runSyncTranscriptRewrite(request) {
  let result;
  try {
    const manager = SessionManager.open({
      agentId: AGENT_ID,
      sessionId: request.sessionId,
      sessionKey: SESSION_KEY,
      storePath: request.storePath,
    });
    const proceed = waitForProceed(request.requestId);
    send({
      phase: "ready",
      requestId: request.requestId,
      value: { eventCount: manager.getEntries().length },
    });
    await proceed;
    // Synchronous rewrite path (removeTrailingEntries -> replacePersistedTranscript):
    // no lock, no await between the manager's load and this call, so a foreign
    // append committed during the "ready" handshake is the only way to race it.
    manager.removeTrailingEntries((entry) => entry.id === request.targetEntryId);
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function runSyncAppendRace(request) {
  let result;
  try {
    const scope = {
      agentId: AGENT_ID,
      sessionId: request.sessionId,
      sessionKey: SESSION_KEY,
      storePath: request.storePath,
    };
    const appendOptions = {
      cwd: process.cwd(),
      eventId: "local-append",
      message: { role: "user", content: "local append" },
      parentId: null,
    };
    // Captured at the exact same point in time regardless of path -- this
    // stands in for a real caller's in-memory fileEntries, which can only
    // ever reflect appends this process itself made.
    let atomicSnapshot;
    if (request.useAtomicSnapshot) {
      const atomic = appendTranscriptMessageWithSnapshotSync(scope, appendOptions);
      atomicSnapshot = atomic.snapshot;
    } else {
      appendTranscriptMessageSync(scope, appendOptions);
    }
    const preHandshakeRows = loadTranscriptEventsWithRowSnapshotSync(scope).rows;
    const nextEntries = preHandshakeRows.map((row) => JSON.parse(row.eventJson));

    const proceed = waitForProceed(request.requestId);
    send({
      phase: "ready",
      requestId: request.requestId,
      value: { eventCount: nextEntries.length },
    });
    await proceed;

    // Old-style path: a separate out-of-transaction refresh taken AFTER the
    // ready/proceed handshake. A foreign append that committed during that
    // gap is folded into this "snapshot" even though nextEntries above never
    // saw it -- the exact defect ClawSweeper flagged at the old
    // refreshPersistedRowSnapshot() call sites in session-manager-persistence.ts.
    // Fixed path: reuse the snapshot captured inside the append's own write
    // transaction, before the handshake ever ran, so it cannot have observed
    // the foreign commit either.
    const snapshotForRewrite = request.useAtomicSnapshot
      ? atomicSnapshot
      : loadTranscriptEventsWithRowSnapshotSync(scope).rows;

    let rewriteRejected = false;
    try {
      replaceTranscriptEventsSync(scope, nextEntries, snapshotForRewrite);
    } catch (error) {
      if (error instanceof SqliteTranscriptMutationConflictError) {
        rewriteRejected = true;
      } else {
        throw error;
      }
    }
    result = { ok: true, rewriteRejected };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function runSyncRewriteRace(request) {
  let result;
  try {
    const scope = {
      agentId: AGENT_ID,
      sessionId: request.sessionId,
      sessionKey: SESSION_KEY,
      storePath: request.storePath,
    };
    const header = { type: "session", version: 3, id: request.sessionId };
    const firstEvents = [
      header,
      {
        type: "message",
        id: "rewrite-a-target",
        parentId: null,
        message: { role: "assistant", content: "rewrite a" },
      },
    ];
    // This first rewrite stands in for a real SessionManagerCore's own prior
    // replacePersistedTranscript() call -- the atomic snapshot it captures
    // here is what a caller like session-manager-core.ts now tracks in
    // persistedRowSnapshot across calls, instead of refreshing it with a
    // separate read after this transaction has already committed.
    const { snapshot: atomicSnapshot } = replaceTranscriptEventsWithSnapshotSync(
      scope,
      firstEvents,
    );
    const nextEvents = [...firstEvents];

    const proceed = waitForProceed(request.requestId);
    send({
      phase: "ready",
      requestId: request.requestId,
      value: { eventCount: nextEvents.length },
    });
    await proceed;

    // Old-style path: a separate out-of-transaction read taken AFTER this
    // rewrite's own commit and AFTER the ready/proceed handshake -- the
    // exact refreshPersistedRowSnapshot() shape ClawSweeper flagged at the
    // rewrite call sites. A foreign append committed during the handshake
    // gap is folded into this "snapshot" even though nextEvents above never
    // saw it. Fixed path: reuse the snapshot captured inside the FIRST
    // rewrite's own write transaction, before the handshake ever ran, so it
    // cannot have observed the foreign commit either.
    const snapshotForRewrite = request.useAtomicSnapshot
      ? atomicSnapshot
      : loadTranscriptEventsWithRowSnapshotSync(scope).rows;

    let rewriteRejected = false;
    try {
      replaceTranscriptEventsSync(scope, nextEvents, snapshotForRewrite);
    } catch (error) {
      if (error instanceof SqliteTranscriptMutationConflictError) {
        rewriteRejected = true;
      } else {
        throw error;
      }
    }
    result = { ok: true, rewriteRejected };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function runSyncInitialHeaderRace(request) {
  let result;
  try {
    // Open a genuinely empty transcript through the real production factory:
    // the session header is deferred until the first record append, exactly the
    // header-then-first-record path ClawSweeper flagged. getEntries() is empty.
    const manager = SessionManager.open({
      agentId: AGENT_ID,
      sessionId: request.sessionId,
      sessionKey: SESSION_KEY,
      storePath: request.storePath,
    });
    const proceed = waitForProceed(request.requestId);
    send({
      phase: "ready",
      requestId: request.requestId,
      value: { eventCount: manager.getEntries().length },
    });
    await proceed;
    // First real appendMessage folds the deferred header into the same
    // transaction and revalidates the manager's tracked (empty) snapshot. A
    // foreign row committed during the handshake gap must make that fold fail
    // closed instead of being silently absorbed and later deleted.
    let appendRejected = false;
    try {
      manager.appendMessage({ role: "user", content: "manager first", timestamp: 1 });
    } catch (error) {
      if (error instanceof SqliteTranscriptMutationConflictError) {
        appendRejected = true;
      } else {
        throw error;
      }
    }
    if (!request.retryAfterConflict) {
      result = { ok: true, appendRejected };
      return result;
    }
    // Retry on the SAME manager instance. The conflict must have reloaded this
    // manager from durable state (foreign header + row), so its snapshot now
    // matches the DB and this second append commits instead of repeating the
    // stale-snapshot conflict forever.
    let retrySucceeded = false;
    manager.appendMessage({ role: "user", content: "manager retry", timestamp: 2 });
    retrySucceeded = true;
    result = { ok: true, appendRejected, retrySucceeded };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function runSyncRawAppendRace(request) {
  let result;
  try {
    // Open an already-populated transcript: the header is NOT deferred, so the
    // manager tracks a non-empty snapshot and takes the raw (non-message) append
    // path. A foreign row lands after open() but before the manager's raw append;
    // the append core rebases the stale declared parentId onto the current DB
    // tail (the same active-branch rebase message appends already get), and the
    // manager surfaces that rebase as effectiveParentId so it reloads instead of
    // trusting a fileEntries view a later rewrite could otherwise silently drop
    // the foreign row from.
    const manager = SessionManager.open({
      agentId: AGENT_ID,
      sessionId: request.sessionId,
      sessionKey: SESSION_KEY,
      storePath: request.storePath,
    });
    const proceed = waitForProceed(request.requestId);
    send({
      phase: "ready",
      requestId: request.requestId,
      value: { eventCount: manager.getEntries().length },
    });
    await proceed;
    // Raw non-message append (model_change) after a foreign row raced the gap.
    manager.appendModelChange("openclaw", "sonnet-4.6");
    result = { ok: true, entryCount: manager.getEntries().length };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}


process.on("message", (request) => {
  if (!request || typeof request !== "object") {
    return;
  }
  if (request.kind === "shutdown") {
    process.exit(0);
  }
  if (request.kind === "proceed") {
    const resolve = proceedResolvers.get(request.requestId);
    proceedResolvers.delete(request.requestId);
    resolve?.();
    return;
  }
  if (!Number.isInteger(request.requestId)) {
    return;
  }
  void (async () => {
    const value =
      request.kind === "reply-init"
        ? await runReplyInit(request)
        : request.kind === "sync-transcript-rewrite"
          ? await runSyncTranscriptRewrite(request)
          : request.kind === "sync-append-race"
            ? await runSyncAppendRace(request)
            : request.kind === "sync-rewrite-race"
              ? await runSyncRewriteRace(request)
              : request.kind === "sync-raw-append-race"
                ? await runSyncRawAppendRace(request)
                : request.kind === "sync-initial-header-race"
                  ? await runSyncInitialHeaderRace(request)
                  : await runTranscriptRewrite(request);
    send({ phase: "result", requestId: request.requestId, value });
  })().catch((error) => {
    send({
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : typeof error,
      },
      phase: "error",
      requestId: request.requestId,
    });
  });
});

process.on("disconnect", () => process.exit(0));
send({ phase: "booted" });
`;
}
