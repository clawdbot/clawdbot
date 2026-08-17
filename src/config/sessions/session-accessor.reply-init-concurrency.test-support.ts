// Cross-process concurrency handshake: spawns one long-lived child worker per test file
// (paying tsx/module cold-start once) and drives request/ready/proceed/result round trips
// against it so tests can inject a foreign commit between the worker's read and its write.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

type ChildResult =
  | {
      ok: true;
      sessionEntry: {
        sessionFile?: string;
        sessionId?: string;
        updatedAt?: number;
      };
    }
  | {
      currentEntry?: {
        sessionId?: string;
        updatedAt?: number;
      };
      ok: false;
      reason: string;
      revision: string;
    };

type TranscriptRewriteChildResult =
  | { ok: true }
  | {
      message: string;
      name: string;
      ok: false;
    };

type SyncAppendRaceChildResult =
  | { ok: true; rewriteRejected: boolean }
  | {
      message: string;
      name: string;
      ok: false;
    };

type ConcurrencyWorkerRequest =
  | {
      kind: "reply-init";
      preparedUpdatedAt: number;
      storePath: string;
    }
  | {
      kind: "transcript-rewrite";
      rewriteMode: "read-then-replace" | "replace-twice";
      sessionId: string;
      storePath: string;
    }
  | {
      kind: "sync-transcript-rewrite";
      sessionId: string;
      storePath: string;
      targetEntryId: string;
    }
  | {
      kind: "sync-append-race";
      sessionId: string;
      storePath: string;
      useAtomicSnapshot: boolean;
    };

type ConcurrencyWorkerReady<TRequest extends ConcurrencyWorkerRequest> = TRequest extends {
  kind: "reply-init";
}
  ? { currentEntry?: unknown; revision: string }
  : { eventCount: number };

type ConcurrencyWorkerResult<TRequest extends ConcurrencyWorkerRequest> = TRequest extends {
  kind: "reply-init";
}
  ? ChildResult
  : TRequest extends { kind: "sync-append-race" }
    ? SyncAppendRaceChildResult
    : TranscriptRewriteChildResult;

type ConcurrencyWorkerMessage =
  | { phase: "booted" }
  | { error: { message: string; name: string }; phase: "error"; requestId: number }
  | { phase: "ready"; requestId: number; value: unknown }
  | { phase: "result"; requestId: number; value: unknown };

// Cold tsx/module loading competes with other CI shards. Pay that cost once
// with a process-start budget, while keeping each concurrency handshake tight.
export const WORKER_BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 10_000;
export const SESSION_KEY = "agent:main:main";
export const AGENT_ID = "main";
// Preserve the OS-process boundary while paying tsx/module startup once per file.
// Every request still uses an isolated store path.
let concurrencyWorker: ReturnType<typeof spawn> | undefined;
let nextRequestId = 0;

function createConcurrencyWorkerScript(
  sessionAccessorUrl: string,
  sessionManagerUrl: string,
): string {
  return `
const {
  appendTranscriptMessageSync,
  appendTranscriptMessageWithSnapshotSync,
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  loadTranscriptRowSnapshotSync,
  replaceTranscriptEventsSync,
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
    const preHandshakeRows = loadTranscriptRowSnapshotSync(scope);
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
      : loadTranscriptRowSnapshotSync(scope);

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

function isWorkerMessage(message: unknown): message is ConcurrencyWorkerMessage {
  return typeof message === "object" && message !== null && "phase" in message;
}

async function waitForWorkerBoot(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for concurrency worker startup"));
    }, WORKER_BOOT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `concurrency worker exited during startup code=${String(code)} signal=${String(signal)}`,
        ),
      );
    };
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message) || message.phase !== "booted") {
        return;
      }
      cleanup();
      resolve();
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export async function getConcurrencyWorker(): Promise<ReturnType<typeof spawn>> {
  if (concurrencyWorker) {
    return concurrencyWorker;
  }
  const sessionAccessorUrl = pathToFileURL(
    path.resolve("src/config/sessions/session-accessor.ts"),
  ).href;
  const sessionManagerUrl = pathToFileURL(
    path.resolve("src/agents/sessions/session-manager.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      createConcurrencyWorkerScript(sessionAccessorUrl, sessionManagerUrl),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  try {
    await waitForWorkerBoot(child);
  } catch (error) {
    child.kill();
    throw error;
  }
  concurrencyWorker = child;
  return child;
}

export async function runConcurrencyScenario<TRequest extends ConcurrencyWorkerRequest>(
  request: TRequest,
  onReady: (value: ConcurrencyWorkerReady<TRequest>) => Promise<void> | void,
): Promise<ConcurrencyWorkerResult<TRequest>> {
  const child = await getConcurrencyWorker();
  const requestId = ++nextRequestId;
  return await new Promise<ConcurrencyWorkerResult<TRequest>>((resolve, reject) => {
    let readyHandled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`timeout waiting for concurrency worker ${request.kind}`));
    }, SCENARIO_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`concurrency worker exited code=${String(code)} signal=${String(signal)}`));
    };
    const onMessage = (message: unknown) => {
      if (
        !isWorkerMessage(message) ||
        !("requestId" in message) ||
        message.requestId !== requestId
      ) {
        return;
      }
      if (message.phase === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        fail(error);
        return;
      }
      if (message.phase === "ready" && !readyHandled) {
        readyHandled = true;
        void Promise.resolve(onReady(message.value as ConcurrencyWorkerReady<TRequest>)).then(
          () => {
            child.send({ kind: "proceed", requestId }, (error) => {
              if (error) {
                fail(error);
              }
            });
          },
          fail,
        );
        return;
      }
      if (message.phase === "result") {
        cleanup();
        resolve(message.value as ConcurrencyWorkerResult<TRequest>);
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    child.send({ ...request, requestId }, (error) => {
      if (error) {
        fail(error);
      }
    });
  });
}

export async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let childStdout = "";
  let childStderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    childStdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    childStderr += String(chunk);
  });

  // The child can exit immediately before this waiter attaches. Honor an
  // already-observed exit or the test will wait forever for a spent event.
  const childExit =
    child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
  if (childExit.code !== 0) {
    throw new Error(
      `${label} child failed code=${String(childExit.code)} signal=${String(childExit.signal)}\nstdout:\n${childStdout}\nstderr:\n${childStderr}`,
    );
  }
}

/** Shuts down the shared concurrency worker if one was started for this test file. */
export async function shutdownConcurrencyWorker(): Promise<void> {
  const child = concurrencyWorker;
  concurrencyWorker = undefined;
  if (!child) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.send({ kind: "shutdown" });
  }
  await waitForChild(child, "concurrency worker shutdown");
}
