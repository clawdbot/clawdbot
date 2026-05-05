import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import {
  markRestartAbortedMainSessionsFromLocks,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStore(sessionsDir: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(store, null, 2));
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const lines = messages.map((message) => JSON.stringify({ message })).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${lines}\n`);
}

function cleanedLockForPath(lockPath: string): SessionLockInspection {
  return {
    lockPath,
    pid: 999_999,
    pidAlive: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removed: true,
  };
}

function cleanedLock(sessionsDir: string, sessionId: string): SessionLockInspection {
  return cleanedLockForPath(path.join(sessionsDir, `${sessionId}.jsonl.lock`));
}

describe("main-session-restart-recovery", () => {
  it("marks only main running sessions whose transcript lock was cleaned", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLock(sessionsDir, "main-session"),
        cleanedLock(sessionsDir, "child-session"),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it("marks a running main session whose cleaned transcript lock is topic-suffixed", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLockForPath(path.join(sessionsDir, `${sessionFile}.lock`))],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("does not mark a session for an unrelated topic lock that only shares its id prefix", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "main-session.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(path.join(sessionsDir, "main-session-topic-unrelated.jsonl.lock")),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBeUndefined();
  });

  it("normalizes relative cleaned lock paths against the current working directory", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(
          path.relative(process.cwd(), path.join(sessionsDir, `${sessionFile}.lock`)),
        ),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile is outside the sessions dir", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "../stale/outside.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, "main-session")],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile belongs to another generated session", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const otherSessionId = "22222222-2222-4222-8222-222222222222";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId,
        sessionFile: `${otherSessionId}.jsonl`,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, sessionId)],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0].params).toMatchObject({
      sessionKey: "agent:main:main",
      deliver: false,
      lane: "main",
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("fails marked sessions with stale approval-pending exec tool results", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      {
        role: "toolResult",
        content: "Approval required (id stale, full stale-approval-id).",
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a durable pending final delivery payload (Phase 2)", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = "The final answer is 42.";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const callParams = vi.mocked(callGateway).mock.calls[0]?.[0].params as { message?: string };
    expect(callParams.message).toContain(pendingPayload);

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:main"]?.pendingFinalDelivery).toBe(true);
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(store["agent:main:main"]?.pendingFinalDeliveryCreatedAt).toBeDefined();
    expect(store["agent:main:main"]?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(store["agent:main:main"]?.pendingFinalDeliveryLastAttemptAt).toBeDefined();
    expect(store["agent:main:main"]?.pendingFinalDeliveryLastError).toBeNull();
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails marked sessions whose transcript tail cannot be resumed", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });
});
