// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTestAsync,
} from "../config/sessions/test-helpers.js";
import { callGateway } from "../gateway/call.js";
import {
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import {
  markRestartAbortedMainSessions,
  markRestartAbortedMainSessionsFromLocks,
  markStartupOrphanedMainSessionsForRecovery,
  recoverStartupOrphanedMainSessions,
  recoverRestartAbortedMainSessions,
  scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetAgentRunContextForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

afterEach(async () => {
  resetGatewayWorkAdmission();
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
  // Simulates lock cleanup after process restart: stale lock removed, owning
  // PID dead, and the transcript path available for recovery.
  return {
    lockPath,
    pid: 999_999,
    pidAlive: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removable: true,
    removed: true,
  };
}

function cleanedLock(sessionsDir: string, sessionId: string): SessionLockInspection {
  return cleanedLockForPath(path.join(sessionsDir, `${sessionId}.jsonl.lock`));
}

function firstGatewayParams(): Record<string, unknown> {
  // Recovery resumes through the gateway. Narrow the first mock call so tests
  // assert request payloads without depending on the gateway return type.
  const call = vi.mocked(callGateway).mock.calls[0];
  if (!call) {
    throw new Error("expected gateway call");
  }
  const params = call[0].params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected gateway params");
  }
  return params as Record<string, unknown>;
}

describe("main-session-restart-recovery", () => {
  it("marks only matching running main sessions by active session key", async () => {
    // Only top-level running main sessions are restart-recoverable. Completed,
    // child, cron, and non-active sessions must not be marked.
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "cron:nightly": {
        sessionId: "cron-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    registerAgentRunContext("restart-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    registerAgentRunContext("key-only-run", {
      sessionKey: "agent:main:main",
    });
    registerAgentRunContext("stale-session-run", {
      sessionKey: "agent:main:main",
      sessionId: "stale-session",
    });
    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main", "agent:main:completed", "agent:main:subagent:child"],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "key-only-run", lifecycleGeneration },
      { runId: "restart-run", lifecycleGeneration },
    ]);
  });

  it("marks active sessions in a configured custom session store", async () => {
    const storePath = path.join(tmpDir, "custom", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:issue-82433": {
            sessionId: "custom-session",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );
    await writeTranscript(path.dirname(storePath), "custom-session", [
      { role: "user", content: "continue this custom-store turn" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionKeys: ["agent:main:issue-82433"],
    });

    const store = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:issue-82433"]?.abortedLastRun).toBe(true);

    const recovery = await recoverRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
    });

    expect(recovery).toEqual({ recovered: 1, failed: 0, skipped: 0 });
  });

  it("persists abort-registry runs after their event context was cleared", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "cleared-context-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "cleared-context-run",
        lifecycleGeneration: "pre-restart",
      },
    ]);
  });

  it("marks queued abort-registry runs before lifecycle start changes session status", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "queued-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      }),
    );
    expect(store["agent:main:main"]?.startedAt).toBeUndefined();
    expect(store["agent:main:main"]?.endedAt).toBeUndefined();
    expect(store["agent:main:main"]?.runtimeMs).toBeUndefined();
  });

  it("marks queued registered runs before lifecycle start without explicit candidates", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
    });
    registerAgentRunContext("queued-context-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-context-run",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
      }),
    );
  });

  it("does not reopen a queued run that completed before store persistence", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "completed-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
      isActiveRun: () => false,
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a session completed after a failed terminal persistence candidate", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 3_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "failed-persistence-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 2_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a terminal row written at the observed event timestamp", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 2_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "just-persisted-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 2_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a completed session via current-generation maintenance-expired abort controller", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 3_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "stale-abort-controller-run",
          lifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 5_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("preserves current-generation markers across repeated restart marking", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "first-restart-run",
            lifecycleGeneration,
          },
        ],
      },
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "second-restart-run",
          lifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "first-restart-run",
        lifecycleGeneration,
      },
      {
        runId: "second-restart-run",
        lifecycleGeneration,
      },
    ]);
  });

  it("replaces an older marker when the same run id is active after another restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "shared-run",
            lifecycleGeneration: "first-generation",
          },
        ],
      },
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "shared-run",
          lifecycleGeneration: "second-generation",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "shared-run",
        lifecycleGeneration: "second-generation",
      },
    ]);
  });

  it("uses active session ids to avoid marking stale duplicate keys in another store", async () => {
    // Custom and default stores can contain the same session key. Active ids
    // keep restart marking tied to the store that owned the interrupted run.
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": {
        sessionId: "stale-default-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:issue-82433": {
            sessionId: "active-custom-session",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["active-custom-session"],
      sessionKeys: ["agent:main:issue-82433"],
    });

    const defaultStore = loadSessionStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("marks custom-store sessions by session id when no session key is available", async () => {
    const storePath = path.join(tmpDir, "custom-by-id", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:custom-by-id": {
            sessionId: "custom-session-id-only",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["custom-session-id-only"],
    });

    const store = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:custom-by-id"]?.abortedLastRun).toBe(true);
  });

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
    const resumeParams = firstGatewayParams();
    expect(resumeParams.sessionKey).toBe("agent:main:main");
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.lane).toBe("main");
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("delivers resumed marked sessions through the current run recovery context", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: 123,
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const resumeParams = firstGatewayParams();
    expect(resumeParams).toMatchObject({
      sessionKey: "agent:main:discord:direct:123",
      deliver: true,
      bestEffortDeliver: true,
      lane: "main",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "123",
    });
  });

  it("does not infer restart delivery from historical session routes", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
  });

  it("does not deliver restart recovery when session send policy denies sends", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      cfg: { session: { sendPolicy: { default: "deny" } } },
      stateDir: tmpDir,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
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
        pendingFinalDeliveryContext: {
          channel: "discord",
          to: "discord:dm:final",
          accountId: "main",
        },
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
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
    expect(firstGatewayParams()).toMatchObject({
      deliver: true,
      bestEffortDeliver: true,
      channel: "discord",
      to: "discord:dm:final",
      accountId: "main",
    });
    expect(firstGatewayParams().message).toContain(pendingPayload);

    const beforeStoreRead = Date.now();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.pendingFinalDelivery).toBe(true);
    expect(entry?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(entry?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(entry?.pendingFinalDeliveryLastError).toBeNull();
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt ?? 0).toBeGreaterThanOrEqual(
      entry?.pendingFinalDeliveryCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
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
    expect(firstGatewayParams().message).toContain("The final answer is 42.");
    expect(firstGatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(firstGatewayParams().message).not.toContain("Conversation info");

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe("The final answer is 42.");
  });

  it("resumes pending final delivery even when the transcript tail is assistant output", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "assistant final was already captured",
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish" },
      { role: "assistant", content: "assistant final was already captured" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayParams().message).toContain("assistant final was already captured");
    const store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.pendingFinalDelivery).toBe(true);
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe(
      "assistant final was already captured",
    );
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

  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        sessionId: "recoverable-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "active-key-session", [
      { role: "user", content: "new run owns this key" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "active-id-session", [
      { role: "user", content: "new run owns this id" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "recoverable-session", [
      { role: "user", content: "recover this one" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 2 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "stale-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "stale-session", [
      { role: "user", content: "recover the stale duplicate" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:main"],
      activeSessionIds: ["new-current-session"],
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("marks startup-orphaned running main sessions before recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:fresh": {
        sessionId: "fresh-session",
        updatedAt: cutoff + 1,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:cron:nightly": {
        sessionId: "cron-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: cutoff - 10_000,
        status: "done",
        restartRecoveryRuns: [
          {
            runId: "completed-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
      "agent:main:already-marked": {
        sessionId: "already-marked-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "marked-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "already-marked-session", [
      { role: "user", content: "already interrupted" },
      { role: "toolResult", content: "done" },
    ]);

    const marked = await markStartupOrphanedMainSessionsForRecovery({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
      updatedBeforeMs: cutoff,
    });

    expect(marked).toEqual({ marked: 1, skipped: 2 });
    let store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.restartRecoveryRuns).toHaveLength(1);
    expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

    const recovered = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(recovered).toEqual({ recovered: 2, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(2);
    store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
  });

  it("recovers only the configured store for duplicate startup-orphaned session keys", async () => {
    const cutoff = Date.now();
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:main": {
        sessionId: "default-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(defaultSessionsDir, "default-main-session", [
      { role: "user", content: "continue default" },
      { role: "toolResult", content: "default result" },
    ]);

    const customStorePath = path.join(tmpDir, "custom-startup-duplicate", "sessions.json");
    await writeSessionStoreForTestAsync(customStorePath, {
      "agent:main:main": {
        sessionId: "custom-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(path.dirname(customStorePath), "custom-main-session", [
      { role: "user", content: "continue custom" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await recoverStartupOrphanedMainSessions({
      cfg: { session: { store: customStorePath } },
      stateDir: tmpDir,
      updatedBeforeMs: cutoff,
    });

    expect(result).toMatchObject({ marked: 2, recovered: 1, failed: 0 });
    // Discovery can revisit the non-routable default store through a canonical path alias.
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeLessThanOrEqual(2);
    expect(callGateway).toHaveBeenCalledOnce();
    const defaultStore = readSessionStoreForTest(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readSessionStoreForTest(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("admits each scheduled recovery attempt as independent root work", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "interrupted response",
      },
    });

    const suspensionRef: {
      current: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
    } = { current: null };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        suspensionRef.current = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspensionRef.current?.commit()).toBe(true);
        throw new Error("retry after suspension");
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed" };
      });

    scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      maxRetries: 2,
      stateDir: tmpDir,
    });

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(suspensionRef.current?.release()).toBe(true);

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledTimes(2);
      const store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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

  it("sends a visible notice through legacy session route before failing an unresumable main session", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        lastChannel: "discord",
        lastTo: "discord:channel:room-1",
        lastAccountId: "default",
        lastThreadId: "thread-1",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
    expect(gatewayCall?.method).toBe("message.action");
    expect(gatewayCall?.params).toMatchObject({
      channel: "discord",
      action: "send",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      sessionId: "main-session",
    });
    expect(gatewayCall?.params?.params).toMatchObject({
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffort: true,
    });
    expect(String((gatewayCall?.params?.params as Record<string, unknown>)?.message)).toContain(
      "couldn't safely resume",
    );

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("failed");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(true);
  });
});
