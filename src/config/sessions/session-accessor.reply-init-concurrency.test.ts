import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const POLL_MS = 20;
const WAIT_TIMEOUT_MS = 10_000;
const SESSION_KEY = "agent:main:main";
const AGENT_ID = "main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function createReplyInitChildScript(sessionAccessorUrl: string): string {
  return `
const fs = await import("node:fs/promises");
const {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} = await import(${JSON.stringify(sessionAccessorUrl)});

const POLL_MS = ${POLL_MS};
const WAIT_TIMEOUT_MS = ${WAIT_TIMEOUT_MS};
const SESSION_KEY = ${JSON.stringify(SESSION_KEY)};
const AGENT_ID = ${JSON.stringify(AGENT_ID)};

async function waitForFile(filePath) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
  }
  throw new Error(\`timeout waiting for \${filePath}\`);
}

async function writeJsonFile(filePath, value) {
  // The parent treats file existence as the readiness signal, so publish atomically.
  const tempPath = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(tempPath, \`\${JSON.stringify(value, null, 2)}\\n\`, "utf8");
  await fs.rename(tempPath, filePath);
}

const storePath = process.env.REPLY_INIT_STORE_PATH;
const readyPath = process.env.REPLY_INIT_READY_PATH;
const proceedPath = process.env.REPLY_INIT_PROCEED_PATH;
const resultPath = process.env.REPLY_INIT_RESULT_PATH;
const preparedUpdatedAt = process.env.REPLY_INIT_PREPARED_UPDATED_AT;
if (!storePath || !readyPath || !proceedPath || !resultPath || !preparedUpdatedAt) {
  throw new Error("reply initialization child env is incomplete");
}

const snapshot = loadReplySessionInitializationSnapshot({
  sessionKey: SESSION_KEY,
  storePath,
});
await writeJsonFile(readyPath, {
  currentEntry: snapshot.currentEntry,
  revision: snapshot.revision,
});

await waitForFile(proceedPath);

const committed = await commitReplySessionInitialization({
  activeSessionKey: SESSION_KEY,
  agentId: AGENT_ID,
  expectedRevision: snapshot.revision,
  sessionEntry: {
    sessionId: "existing-session",
    updatedAt: Number(preparedUpdatedAt),
  },
  sessionKey: SESSION_KEY,
  snapshotEntry: snapshot.currentEntry,
  storePath,
});
await writeJsonFile(resultPath, committed);
`;
}

function createTranscriptRewriteChildScript(sessionAccessorUrl: string): string {
  return `
const fs = await import("node:fs/promises");
const { withTranscriptWriteLock } = await import(${JSON.stringify(sessionAccessorUrl)});

const POLL_MS = ${POLL_MS};
const WAIT_TIMEOUT_MS = ${WAIT_TIMEOUT_MS};
const SESSION_KEY = ${JSON.stringify(SESSION_KEY)};
const AGENT_ID = ${JSON.stringify(AGENT_ID)};

async function waitForFile(filePath) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
  }
  throw new Error(\`timeout waiting for \${filePath}\`);
}

async function writeJsonFile(filePath, value) {
  const tempPath = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(tempPath, \`\${JSON.stringify(value, null, 2)}\\n\`, "utf8");
  await fs.rename(tempPath, filePath);
}

const storePath = process.env.TRANSCRIPT_REWRITE_STORE_PATH;
const sessionId = process.env.TRANSCRIPT_REWRITE_SESSION_ID;
const readyPath = process.env.TRANSCRIPT_REWRITE_READY_PATH;
const proceedPath = process.env.TRANSCRIPT_REWRITE_PROCEED_PATH;
const resultPath = process.env.TRANSCRIPT_REWRITE_RESULT_PATH;
const rewriteMode = process.env.TRANSCRIPT_REWRITE_MODE ?? "read-then-replace";
if (!storePath || !sessionId || !readyPath || !proceedPath || !resultPath) {
  throw new Error("transcript rewrite child env is incomplete");
}

let result;
try {
  await withTranscriptWriteLock(
    {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    },
    async (transcript) => {
      if (rewriteMode === "replace-twice") {
        const firstReplacement = [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: "first-replacement",
            parentId: null,
            message: { role: "assistant", content: "first replacement" },
          },
        ];
        await transcript.replaceEvents(firstReplacement);
        await writeJsonFile(readyPath, { eventCount: firstReplacement.length });
        await waitForFile(proceedPath);
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
      await writeJsonFile(readyPath, { eventCount: events.length });
      await waitForFile(proceedPath);
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
await writeJsonFile(resultPath, result);
`;
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

  // The file handshake can complete immediately before this waiter attaches.
  // Honor an already-observed exit or the test will wait forever for a spent event.
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
    const sessionAccessorUrl = pathToFileURL(
      path.resolve("src/config/sessions/session-accessor.ts"),
    ).href;
    const storePath = path.join(tempDir, "sessions.json");
    const readyPath = path.join(tempDir, "snapshot-ready.json");
    const proceedPath = path.join(tempDir, "proceed");
    const resultPath = path.join(tempDir, "result.json");
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

      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          createReplyInitChildScript(sessionAccessorUrl),
        ],
        {
          env: {
            ...process.env,
            REPLY_INIT_PREPARED_UPDATED_AT: String(preparedUpdatedAt),
            REPLY_INIT_PROCEED_PATH: proceedPath,
            REPLY_INIT_READY_PATH: readyPath,
            REPLY_INIT_RESULT_PATH: resultPath,
            REPLY_INIT_STORE_PATH: storePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await waitForFile(readyPath);
      const snapshot = await readJsonFile<{ currentEntry?: unknown; revision: string }>(readyPath);
      expect(snapshot.revision).toBe(JSON.stringify({ sessionId: "existing-session" }));

      await updateSessionEntry(
        { sessionKey: SESSION_KEY, storePath },
        () => ({ updatedAt: activeTurnUpdatedAt }),
        { skipMaintenance: true },
      );
      await fs.writeFile(proceedPath, "go\n", "utf8");
      await waitForChild(child, "reply initialization");

      const result = await readJsonFile<ChildResult>(resultPath);
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
    const sessionAccessorUrl = pathToFileURL(
      path.resolve("src/config/sessions/session-accessor.ts"),
    ).href;
    const storePath = path.join(tempDir, "sessions.json");
    const readyPath = path.join(tempDir, "rewrite-ready.json");
    const proceedPath = path.join(tempDir, "proceed");
    const resultPath = path.join(tempDir, "result.json");
    const sessionId = "cross-process-transcript";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    let child: ReturnType<typeof spawn> | undefined;

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

      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          createTranscriptRewriteChildScript(sessionAccessorUrl),
        ],
        {
          env: {
            ...process.env,
            TRANSCRIPT_REWRITE_PROCEED_PATH: proceedPath,
            TRANSCRIPT_REWRITE_READY_PATH: readyPath,
            TRANSCRIPT_REWRITE_RESULT_PATH: resultPath,
            TRANSCRIPT_REWRITE_SESSION_ID: sessionId,
            TRANSCRIPT_REWRITE_STORE_PATH: storePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await waitForFile(readyPath);
      expect(await readJsonFile<{ eventCount: number }>(readyPath)).toEqual({ eventCount: 2 });

      await appendTranscriptMessage(scope, {
        cwd: tempDir,
        message: {
          role: "user",
          content: "committed concurrent append",
          timestamp: Date.now(),
        },
      });
      await fs.writeFile(proceedPath, "go\n", "utf8");
      await waitForChild(child, "transcript rewrite");

      const result = await readJsonFile<TranscriptRewriteChildResult>(resultPath);
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
      if (child?.exitCode === null) {
        child.kill();
      }
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
    const sessionAccessorUrl = pathToFileURL(
      path.resolve("src/config/sessions/session-accessor.ts"),
    ).href;
    const storePath = path.join(tempDir, "sessions.json");
    const readyPath = path.join(tempDir, "rewrite-ready.json");
    const proceedPath = path.join(tempDir, "rewrite-proceed");
    const resultPath = path.join(tempDir, "rewrite-result.json");
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
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          createTranscriptRewriteChildScript(sessionAccessorUrl),
        ],
        {
          env: {
            ...process.env,
            TRANSCRIPT_REWRITE_MODE: "replace-twice",
            TRANSCRIPT_REWRITE_PROCEED_PATH: proceedPath,
            TRANSCRIPT_REWRITE_READY_PATH: readyPath,
            TRANSCRIPT_REWRITE_RESULT_PATH: resultPath,
            TRANSCRIPT_REWRITE_SESSION_ID: sessionId,
            TRANSCRIPT_REWRITE_STORE_PATH: storePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await waitForFile(readyPath);
      expect(await readJsonFile<{ eventCount: number }>(readyPath)).toEqual({ eventCount: 2 });
      await appendTranscriptMessage(scope, {
        cwd: tempDir,
        eventId: "concurrent-append",
        message: { role: "user", content: "concurrent append" },
        parentId: "first-replacement",
      });
      await fs.writeFile(proceedPath, "go\n", "utf8");
      await waitForChild(child, "double transcript rewrite");

      expect(await readJsonFile<TranscriptRewriteChildResult>(resultPath)).toMatchObject({
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
      if (child?.exitCode === null) {
        child.kill();
      }
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
