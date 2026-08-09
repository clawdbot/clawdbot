import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
  upsertSessionEntry,
  withTranscriptWriteLock,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

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
  : TranscriptRewriteChildResult;

type ConcurrencyWorkerMessage =
  | { phase: "booted" }
  | { error: { message: string; name: string }; phase: "error"; requestId: number }
  | { phase: "ready"; requestId: number; value: unknown }
  | { phase: "result"; requestId: number; value: unknown };

// Cold tsx/module loading competes with other CI shards. Pay that cost once
// with a process-start budget, while keeping each concurrency handshake tight.
const WORKER_BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 10_000;
const SESSION_KEY = "agent:main:main";
const AGENT_ID = "main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Preserve the OS-process boundary while paying tsx/module startup once per file.
// Every request still uses an isolated store path.
let concurrencyWorker: ReturnType<typeof spawn> | undefined;
let nextRequestId = 0;

function createConcurrencyWorkerScript(sessionAccessorUrl: string): string {
  return `
const {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  withTranscriptWriteLock,
} = await import(${JSON.stringify(sessionAccessorUrl)});

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

async function getConcurrencyWorker(): Promise<ReturnType<typeof spawn>> {
  if (concurrencyWorker) {
    return concurrencyWorker;
  }
  const sessionAccessorUrl = pathToFileURL(
    path.resolve("src/config/sessions/session-accessor.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      createConcurrencyWorkerScript(sessionAccessorUrl),
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

async function runConcurrencyScenario<TRequest extends ConcurrencyWorkerRequest>(
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

async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
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

describe("session accessor cross-process concurrency", () => {
  beforeAll(async () => {
    await getConcurrencyWorker();
  }, WORKER_BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    const child = concurrencyWorker;
    concurrencyWorker = undefined;
    if (!child) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ kind: "shutdown" });
    }
    await waitForChild(child, "concurrency worker shutdown");
  });

  it("observes a child that exited before the waiter attached", async () => {
    const child = spawn(process.execPath, ["--eval", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });

    await waitForChild(child, "already exited");
  });

  it("commits after same-session activity from another process", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-init-"));
    const storePath = path.join(tempDir, "sessions.json");
    try {
      await upsertSessionEntry(
        { sessionKey: SESSION_KEY, storePath },
        {
          sessionId: "existing-session",
          updatedAt: Date.now(),
        },
      );
      const initialUpdatedAt = loadSessionEntry({
        readConsistency: "latest",
        sessionKey: SESSION_KEY,
        storePath,
      })?.updatedAt;
      if (typeof initialUpdatedAt !== "number") {
        throw new Error("initial session timestamp was not persisted");
      }
      const activeTurnUpdatedAt = initialUpdatedAt + 20;
      const preparedUpdatedAt = initialUpdatedAt + 30;

      const result = await runConcurrencyScenario(
        {
          kind: "reply-init",
          preparedUpdatedAt,
          storePath,
        },
        async (snapshot) => {
          expect(snapshot.revision).toBe(JSON.stringify({ sessionId: "existing-session" }));
          await updateSessionEntry(
            { sessionKey: SESSION_KEY, storePath },
            () => ({ updatedAt: activeTurnUpdatedAt }),
            { skipMaintenance: true },
          );
        },
      );
      expect(result).toMatchObject({
        ok: true,
        sessionEntry: {
          sessionId: "existing-session",
          updatedAt: preparedUpdatedAt,
        },
      });
      expect(
        loadSessionEntry({ readConsistency: "latest", sessionKey: SESSION_KEY, storePath }),
      ).toMatchObject({
        sessionId: "existing-session",
        updatedAt: preparedUpdatedAt,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a transcript rewrite after another process commits an append", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-rewrite-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "cross-process-transcript";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntry(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      await replaceSqliteTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
      ]);

      const result = await runConcurrencyScenario(
        {
          kind: "transcript-rewrite",
          rewriteMode: "read-then-replace",
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "user",
              content: "committed concurrent append",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            content: "committed concurrent append",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves locked replaceEvents without a prior readEvents call", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-replace-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "replace-without-read";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    const replacement = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "replacement",
        parentId: null,
        message: { role: "assistant", content: "replacement content" },
      },
    ];

    try {
      await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      await withTranscriptWriteLock(scope, async (transcript) => {
        await transcript.replaceEvents(replacement);
      });

      await expect(loadTranscriptEvents(scope)).resolves.toEqual(replacement);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("guards a second replace after replacing without a prior read", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-double-replace-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "double-replace-without-read";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    const firstReplacement = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "first-replacement",
        parentId: null,
        message: { role: "assistant", content: "first replacement" },
      },
    ];
    try {
      await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      const result = await runConcurrencyScenario(
        {
          kind: "transcript-rewrite",
          rewriteMode: "replace-twice",
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            eventId: "concurrent-append",
            message: { role: "user", content: "concurrent append" },
            parentId: "first-replacement",
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        ...firstReplacement,
        expect.objectContaining({
          type: "message",
          id: "concurrent-append",
          parentId: "first-replacement",
          message: expect.objectContaining({
            role: "user",
            content: "concurrent append",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("refreshes a read snapshot after an append in the same locked callback", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-self-append-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "rewrite-after-own-append";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };

    try {
      await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      await replaceSqliteTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
      ]);

      await withTranscriptWriteLock(scope, async (transcript) => {
        await transcript.readEvents();
        await transcript.appendMessage({
          cwd: tempDir,
          eventId: "owned-append",
          message: { role: "user", content: "owned append" },
          parentId: "rewrite-target",
        });
        const currentEvents = await loadTranscriptEvents(scope);
        const rewrittenEvents = currentEvents.map((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event) ||
            (event as { id?: unknown }).id !== "rewrite-target"
          ) {
            return event;
          }
          return Object.assign({}, event, {
            message: { role: "assistant", content: "rewritten content" },
          });
        });
        await transcript.replaceEvents(rewrittenEvents);
      });

      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "rewritten content" },
        },
        expect.objectContaining({
          type: "message",
          id: "owned-append",
          parentId: "rewrite-target",
          message: { role: "user", content: "owned append" },
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
