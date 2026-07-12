import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, updateSessionEntry, upsertSessionEntry } from "./session-accessor.js";

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

const POLL_MS = 20;
const WAIT_TIMEOUT_MS = 10_000;
const SESSION_KEY = "agent:main:main";
const AGENT_ID = "main";

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

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
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

  const childExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  if (childExit.code !== 0) {
    throw new Error(
      `reply initialization child failed code=${String(childExit.code)} signal=${String(childExit.signal)}\nstdout:\n${childStdout}\nstderr:\n${childStderr}`,
    );
  }
}

describe("reply session initialization concurrency", () => {
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
      await waitForChild(child);

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
});
