// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  listSessionEntries,
  loadSessionEntry as loadSessionEntryRaw,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferred } from "../test-utils/deferred.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "./embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunHandleSessionId,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./embedded-agent-runner/runs.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import { claimMainSessionRecoveryOwner } from "./main-session-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markRestartAbortedMainSessionsFromLocks,
  markStartupOrphanedMainSessionsForRecovery,
  recoverStartupOrphanedMainSessions as recoverStartupOrphanedMainSessionsBase,
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  retryRestartAbortedMainSessionRecovery as retryRestartAbortedMainSessionRecoveryBase,
  retryRestartAbortedMainSessionRecoveryAfterOwnerRelease as retryRestartAbortedMainSessionRecoveryAfterOwnerReleaseBase,
  scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease,
  scheduleRestartAbortedMainSessionRecovery as scheduleRestartAbortedMainSessionRecoveryBase,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";
import {
  createAssistantToolCallMessage,
  createSessionEntry,
  createSessionStore,
  type SessionEntryFixture,
  expectRecord,
  mockCallArg,
  waitForFast,
} from "./subagent-test-fixtures.test-helpers.js";

const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));
const runtimePluginMocks = vi.hoisted(() => ({
  ensureRuntimePluginsLoaded: vi.fn(),
  findRestartRecoveryUnsafeReplyHook: vi.fn<() => string | undefined>(),
}));
const discordDeliveryContext = {
  channel: "discord",
  to: "discord:dm:123",
} as const;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const mockRecoveryRuntime = {
  dispatchAgent: async <T>(params: Record<string, unknown>, timeoutMs?: number) =>
    (await callGateway({ method: "agent", params, timeoutMs })) as T,
  waitForAgent: async <T>(params: Record<string, unknown>, timeoutMs?: number) =>
    (await callGateway({ method: "agent.wait", params, timeoutMs })) as T,
  sendRecoveryNotice: async <T>(params: Record<string, unknown>, timeoutMs?: number) =>
    (await callGateway({ method: "message.action", params, timeoutMs })) as T,
};

type RecoveryParams<T extends { gatewayRuntime: unknown }> = Omit<T, "gatewayRuntime"> &
  Partial<Pick<T, "gatewayRuntime">>;

const recoverRestartAbortedMainSessions = (
  params: RecoveryParams<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0]>,
) => recoverRestartAbortedMainSessionsBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const recoverStartupOrphanedMainSessions = (
  params: RecoveryParams<Parameters<typeof recoverStartupOrphanedMainSessionsBase>[0]>,
) => recoverStartupOrphanedMainSessionsBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const retryRestartAbortedMainSessionRecovery = (
  params: RecoveryParams<Parameters<typeof retryRestartAbortedMainSessionRecoveryBase>[0]>,
) => retryRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const retryRestartAbortedMainSessionRecoveryAfterOwnerRelease = (
  params: RecoveryParams<
    Parameters<typeof retryRestartAbortedMainSessionRecoveryAfterOwnerReleaseBase>[0]
  >,
) =>
  retryRestartAbortedMainSessionRecoveryAfterOwnerReleaseBase({
    gatewayRuntime: mockRecoveryRuntime,
    ...params,
  });
const scheduleRestartAbortedMainSessionRecovery = (
  params: RecoveryParams<Parameters<typeof scheduleRestartAbortedMainSessionRecoveryBase>[0]>,
) =>
  scheduleRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });

async function expectRecovery(
  expected: { recovered: number; failed: number; skipped: number },
  cfg?: Parameters<typeof recoverRestartAbortedMainSessions>[0]["cfg"],
): Promise<void> {
  const params = cfg === undefined ? { stateDir: tmpDir } : { cfg, stateDir: tmpDir };
  await expect(recoverRestartAbortedMainSessions(params)).resolves.toEqual(expected);
}

function gatewayParams(): Record<string, unknown> {
  return expectRecord(mockCallArg(callGateway).params, "gateway params");
}

vi.mock("../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/transcript.js")>();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementation(
    actual.appendAssistantMessageToSessionTranscript,
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript:
      transcriptMocks.appendAssistantMessageToSessionTranscript,
  };
});

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: runtimePluginMocks.ensureRuntimePluginsLoaded,
}));

vi.mock("../plugins/restart-recovery-hook-safety.js", () => ({
  findRestartRecoveryUnsafeReplyHook: runtimePluginMocks.findRestartRecoveryUnsafeReplyHook,
}));

let tmpDir: string;

function loadSessionEntry(
  scope: Parameters<typeof loadSessionEntryRaw>[0],
): SessionEntry | undefined {
  return loadSessionEntryRaw(scope) as SessionEntry | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }));
  runtimePluginMocks.findRestartRecoveryUnsafeReplyHook.mockReturnValue(undefined);
  resetAgentEventsForTest();
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

async function writeStorePath(
  storePath: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
    ),
  );
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    updatedAt: Date.now() - 10_000,
    status: "running",
    abortedLastRun: true,
    ...overrides,
  });
}

function runningSessionEntry(sessionId: string, overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}

function mainSessionStore(
  overrides: SessionEntryFixture = {},
  sessionKey = "agent:main:main",
): Record<string, SessionEntry> {
  return createSessionStore(mainSessionEntry(overrides), sessionKey);
}

function deliveredReceiptEntry(
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
): Partial<SessionEntry> {
  return {
    restartRecoveryBeforeAgentReplyState: "continue",
    restartRecoveryDeliveryReceiptState: "delivered-terminal",
    restartRecoveryDeliveryToolCallId: toolCallId,
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryContext: discordDeliveryContext,
  };
}

async function writeMainSession({
  sessionsDir,
  sessionKey = "agent:main:main",
  ...entry
}: SessionEntryFixture & { sessionsDir: string; sessionKey?: string }): Promise<void> {
  await writeStore(sessionsDir, mainSessionStore(entry, sessionKey));
}

function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = Object.entries(readStore(storePath)).find(
    ([, entry]) => entry.sessionId === sessionId,
  )?.[0];
  if (!sessionKey) {
    throw new Error(`expected session entry for transcript fixture: ${sessionId}`);
  }
  for (const message of messages) {
    await appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      {
        cwd: sessionsDir,
        message,
      },
    );
  }
}

async function writeCompletedToolTranscript(sessionsDir: string): Promise<void> {
  await writeTranscript(sessionsDir, "main-session", [
    { role: "user", content: "run the tool" },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
    { role: "toolResult", content: "done" },
  ]);
}

async function loadTestTranscript(
  sessionKey: string,
  storePath: string,
): Promise<Array<{ message?: Record<string, unknown> }>> {
  return (await loadTranscriptEvents({
    sessionId: "main-session",
    sessionKey,
    storePath,
  })) as Array<{ message?: Record<string, unknown> }>;
}

function codeModeCheckpointMessage(
  toolName: "exec" | "wait" = "wait",
  checkpoint: Record<string, unknown> = {
    status: "waiting",
    runId: "cm_interrupted",
    replaySafe: true,
  },
) {
  return {
    role: "toolResult",
    toolName,
    content: [
      {
        type: "text",
        text: JSON.stringify(checkpoint),
      },
    ],
  };
}

function codeModeWaitCallMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-wait-1",
        name: "wait",
        arguments: { runId: "cm_interrupted" },
      },
    ],
    stopReason: "toolUse",
  };
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

describe("main-session-restart-recovery", () => {
  it("marks only matching running main sessions by active session key", async () => {
    // Only top-level running main sessions are restart-recoverable. Completed,
    // child, cron, and non-active sessions must not be marked.
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("main-session"),
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        ...runningSessionEntry("child-session"),
        spawnDepth: 1,
      },
      "cron:nightly": {
        ...runningSessionEntry("cron-session"),
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("custom-session"),
      },
    });
    await writeTranscript(path.dirname(storePath), "custom-session", [
      { role: "user", content: "continue this custom-store turn" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionKeys: ["agent:main:issue-82433"],
    });

    const store = readStore(storePath);
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
    await writeMainSession({
      sessionsDir,
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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

  it.each([
    {
      name: "does not reopen a queued run that completed before store persistence",
      updatedAt: undefined,
      runId: "completed-run",
      observedAt: undefined,
      isActive: false,
      currentGeneration: false,
    },
    {
      name: "does not reopen a session completed after a failed terminal persistence candidate",
      updatedAt: 3_000,
      runId: "failed-persistence-run",
      observedAt: 2_000,
      isActive: true,
      currentGeneration: false,
    },
    {
      name: "does not reopen a terminal row written at the observed event timestamp",
      updatedAt: 2_000,
      runId: "just-persisted-run",
      observedAt: 2_000,
      isActive: true,
      currentGeneration: false,
    },
    {
      name: "does not reopen a completed session via current-generation maintenance-expired abort controller",
      updatedAt: 3_000,
      runId: "stale-abort-controller-run",
      observedAt: 5_000,
      isActive: true,
      currentGeneration: true,
    },
  ])("$name", async ({ updatedAt, runId, observedAt, isActive, currentGeneration }) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": createSessionEntry({
        sessionId: "main-session",
        updatedAt: updatedAt ?? Date.now() - 10_000,
        status: "done",
      }),
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId,
          lifecycleGeneration: currentGeneration
            ? getAgentEventLifecycleGeneration()
            : "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          ...(observedAt === undefined ? {} : { observedAt }),
        },
      ],
      isActiveRun: () => isActive,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("preserves current-generation markers across repeated restart marking", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeMainSession({
      sessionsDir,
      restartRecoveryRuns: [
        {
          runId: "first-restart-run",
          lifecycleGeneration,
        },
      ],
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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
    await writeMainSession({
      sessionsDir,
      restartRecoveryRuns: [
        {
          runId: "shared-run",
          lifecycleGeneration: "first-generation",
        },
      ],
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
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
        ...runningSessionEntry("stale-default-session"),
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("active-custom-session"),
      },
    });

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["active-custom-session"],
      sessionKeys: ["agent:main:issue-82433"],
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("marks custom-store sessions by session id when no session key is available", async () => {
    const storePath = path.join(tmpDir, "custom-by-id", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:custom-by-id": {
        ...runningSessionEntry("custom-session-id-only"),
      },
    });

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["custom-session-id-only"],
    });

    const store = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:custom-by-id"]?.abortedLastRun).toBe(true);
  });

  it("marks only main running sessions whose transcript lock was cleaned", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("main-session"),
      },
      "agent:main:subagent:child": {
        ...runningSessionEntry("child-session"),
        spawnDepth: 1,
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLock(sessionsDir, "main-session"),
        cleanedLock(sessionsDir, "child-session"),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it.each([
    {
      name: "marks a running main session whose cleaned transcript lock is topic-suffixed",
      sessionKey: "agent:main:discord:channel:123:thread:1234567890",
      sessionId: "main-session",
      sessionFile: "main-session-topic-1234567890.jsonl",
      lockKind: "session-file",
      marked: 1,
    },
    {
      name: "does not mark a session for an unrelated topic lock that only shares its id prefix",
      sessionKey: "agent:main:main",
      sessionId: "main-session",
      sessionFile: "main-session.jsonl",
      lockKind: "unrelated",
      marked: 0,
    },
    {
      name: "normalizes relative cleaned lock paths against the current working directory",
      sessionKey: "agent:main:discord:channel:123:thread:1234567890",
      sessionId: "main-session",
      sessionFile: "main-session-topic-1234567890.jsonl",
      lockKind: "relative-session-file",
      marked: 1,
    },
    {
      name: "falls back to the session id transcript lock when persisted sessionFile is outside the sessions dir",
      sessionKey: "agent:main:main",
      sessionId: "main-session",
      sessionFile: "../stale/outside.jsonl",
      lockKind: "session-id",
      marked: 1,
    },
    {
      name: "falls back to the session id transcript lock when persisted sessionFile belongs to another generated session",
      sessionKey: "agent:main:main",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionFile: "22222222-2222-4222-8222-222222222222.jsonl",
      lockKind: "session-id",
      marked: 1,
    },
  ])("$name", async ({ sessionKey, sessionId, sessionFile, lockKind, marked }) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      [sessionKey]: runningSessionEntry(sessionId, { sessionFile }),
    });
    const lockFile =
      lockKind === "unrelated"
        ? "main-session-topic-unrelated.jsonl.lock"
        : lockKind === "session-id"
          ? `${sessionId}.jsonl.lock`
          : `${sessionFile}.lock`;
    const lockPath = path.join(sessionsDir, lockFile);
    const normalizedLockPath =
      lockKind === "relative-session-file" ? path.relative(process.cwd(), lockPath) : lockPath;

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLockForPath(normalizedLockPath)],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked, skipped: 0 });
    if (marked === 1) {
      expect(store[sessionKey]?.abortedLastRun).toBe(true);
    } else {
      expect(store[sessionKey]?.abortedLastRun).toBeUndefined();
    }
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams.sessionKey).toBe("agent:main:main");
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.lane).toBe("main");
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it.each([
    {
      label: "same-process lifecycle rotation",
      sessionKey: "agent:main:telegram:group:-100:topic:2",
      sessionId: "topic-2-session",
      restartRecoveryRuns: [
        {
          runId: "announce:v1:agent:main:subagent:child:run-1",
          lifecycleGeneration: "generation-old",
        },
      ],
      userMessage: { role: "user", content: "earlier human request" },
    },
    {
      label: "full restart",
      sessionKey: "agent:main:telegram:group:-100:topic:8893",
      sessionId: "topic-8893-session",
      restartRecoveryRuns: undefined,
      userMessage: {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
    },
  ])("reconciles an interrupted completion after $label", async (fixture) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      [fixture.sessionKey]: {
        sessionId: fixture.sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: fixture.restartRecoveryRuns,
      },
    });
    await writeTranscript(sessionsDir, fixture.sessionId, [
      fixture.userMessage,
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: fixture.sessionKey, storePath })).toMatchObject({
      status: "killed",
      abortedLastRun: false,
    });
    expect(readStore(storePath)[fixture.sessionKey]).not.toHaveProperty("restartRecoveryRuns");
  });

  it("resumes an explicit human run despite stale completion provenance", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100:topic:41818";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41818-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "human-run-2", lifecycleGeneration: "generation-old" }],
      },
    });
    await writeTranscript(sessionsDir, "topic-41818-session", [
      {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
  });

  it("retries when a human recovery run appears during announce reconciliation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-100:topic:41819";
    const announceRun = {
      runId: "announce:v1:agent:main:subagent:child:run-race",
      lifecycleGeneration: "generation-old",
    };
    const humanRun = { runId: "human-run-race", lifecycleGeneration: "generation-old" };
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41819-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [announceRun],
      },
    });
    await writeTranscript(sessionsDir, "topic-41819-session", [
      { role: "user", content: "earlier human request" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);
    const updateSessionEntry = sessionAccessor.updateSessionEntry;
    let injectedHumanRun = false;
    const updateSpy = vi
      .spyOn(sessionAccessor, "updateSessionEntry")
      .mockImplementation(async (scope, update, options) => {
        if (!injectedHumanRun) {
          injectedHumanRun = true;
          await updateSessionEntry(scope, (entry) => ({
            restartRecoveryRuns: [...(entry.restartRecoveryRuns ?? []), humanRun],
          }));
        }
        return await updateSessionEntry(scope, update, options);
      });

    try {
      await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    } finally {
      updateSpy.mockRestore();
    }

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [announceRun, humanRun],
    });
    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("delivers resumed marked sessions through the current run recovery context", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        ...runningSessionEntry("main-session"),
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
    await writeCompletedToolTranscript(sessionsDir);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    const resumeParams = gatewayParams() as Record<string, unknown>;
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

  it("reuses a transcript-only claim without inferring historical session routes", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "control-ui-run",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
        restartRecoverySourceIngress: "internal",
        restartRecoverySourceReplyDeliveryMode: "message_tool_only",
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    let claimAtDispatch: string | undefined;
    let sourceClaimAtDispatch: string | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const entry = loadSessionEntry({
        sessionKey: "agent:main:discord:direct:123",
        storePath,
      });
      claimAtDispatch = entry?.restartRecoveryDeliveryRunId;
      sourceClaimAtDispatch = entry?.restartRecoveryDeliverySourceRunId;
      return { runId: String((params as { idempotencyKey?: unknown }).idempotencyKey) };
    });

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(claimAtDispatch).toBe(resumeParams.idempotencyKey);
    expect(claimAtDispatch).not.toBe("control-ui-run");
    expect(sourceClaimAtDispatch).toBe("control-ui-run");
  });

  it("retains one stable transcript-only claim across ambiguous dispatch rejection", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable"));

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 }, {});

    const firstRecoveryRunId = (
      vi.mocked(callGateway).mock.calls[0]?.[0].params as { idempotencyKey?: unknown } | undefined
    )?.idempotencyKey;
    expect(firstRecoveryRunId).toEqual(expect.any(String));
    expect(firstRecoveryRunId).not.toBe("control-ui-run");
    const pending = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(pending).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 1 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      sessionId: "main-session",
      status: "running",
    });
    expect(pending?.mainRestartRecovery?.reservation).toBeUndefined();

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(runIds).toEqual([firstRecoveryRunId, firstRecoveryRunId]);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      mainRestartRecovery: { chargedAttempts: 2 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
  });

  it("retries reservation cleanup after a transient session-store failure", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchFailed = true;
      throw new Error("gateway unavailable");
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess && cleanupFailures < 2) {
          cleanupFailures += 1;
          throw new Error("transient session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ recovered: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }

    expect(cleanupFailures).toBe(2);
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("schedules exact reservation cleanup after immediate retries are exhausted", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchFailed = true;
      throw new Error("gateway unavailable");
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const schedulePendingSpy = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => {});
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess && cleanupFailures < 3) {
          cleanupFailures += 1;
          throw new Error("extended session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ recovered: 0, failed: 1, skipped: 0 });
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery
          ?.reservation,
      ).toBeDefined();
      await vi.waitFor(
        () => {
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery
              ?.reservation,
          ).toBeUndefined();
        },
        { timeout: 3_000 },
      );
      expect(schedulePendingSpy).toHaveBeenCalledWith({
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      });
    } finally {
      schedulePendingSpy.mockRestore();
      replacementSpy.mockRestore();
    }

    expect(cleanupFailures).toBe(3);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
    ).toMatchObject({ chargedAttempts: 1 });
  });

  it("retries reservation cleanup when durable dispatch preparation is rejected", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let preparationRejected = false;
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
        if (
          !preparationRejected &&
          params.requireWriteSuccess !== true &&
          entry?.mainRestartRecovery?.reservation
        ) {
          preparationRejected = true;
          return false;
        }
        if (preparationRejected && params.requireWriteSuccess && cleanupFailures < 2) {
          cleanupFailures += 1;
          throw new Error("transient session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ recovered: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }

    expect(preparationRejected).toBe(true);
    expect(cleanupFailures).toBe(2);
    expect(callGateway).not.toHaveBeenCalled();
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("refunds an explicit Gateway rejection before recovery admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "restart recovery reservation is stale",
        retryable: false,
      }),
    );

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { recovered: 0, failed: 1, skipped: 0 },
    );

    expect(callGateway).toHaveBeenCalledOnce();
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not settle an ambiguous recovery after a foreground owner wins admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        throw new Error("ambiguous dispatch transport failure");
      }
      const owner = await claimMainSessionRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionId: "main-session",
        target: { sessionKey: "agent:main:main", storePath },
      });
      expect(owner.kind).toBe("claimed");
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { recovered: 0, failed: 1, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      status: "running",
      mainRestartRecovery: {
        foregroundClaims: { tokens: [expect.any(String)] },
      },
    });
  });

  it("rolls back the reservation when ambiguous settlement persistence fails", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        dispatchFailed = true;
        throw new Error("ambiguous dispatch transport failure");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let postDispatchWrites = 0;
    let settlementFailed = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess !== true) {
          postDispatchWrites += 1;
          if (postDispatchWrites === 2) {
            settlementFailed = true;
            throw new Error("settlement store failure");
          }
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ recovered: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }
    expect(settlementFailed).toBe(true);
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry).toMatchObject({ status: "running", abortedLastRun: true });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("settles an admitted recovery that completed before its ambiguous response", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        const recoveryRunId = String(
          (request.params as { idempotencyKey?: unknown }).idempotencyKey,
        );
        const current = loadSessionEntry({ sessionKey: "agent:main:main", storePath })!;
        const completed: SessionEntry = {
          ...current,
          status: "done",
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: undefined,
          restartRecoveryDeliverySourceRunId: undefined,
          restartRecoveryRuns: undefined,
          restartRecoveryTerminalRunIds: [recoveryRunId],
          mainRestartRecovery: current.mainRestartRecovery
            ? { ...current.mainRestartRecovery, reservation: undefined }
            : undefined,
        };
        await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, completed);
        throw new Error("accepted response was lost after completion");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { recovered: 1, failed: 0, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      status: "done",
    });
  });

  it("settles a reused recovery RPC whose accepted cache already completed", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "ok",
        endedAt: Date.now(),
      });

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(vi.mocked(callGateway).mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "recovery-run", timeoutMs: 0 },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      endedAt: expect.any(Number),
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      sessionId: "main-session",
      status: "done",
    });
    const settled = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(settled?.mainRestartRecovery).toBeUndefined();
  });

  it("does not settle a cached terminal response after a foreground owner wins admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    let foregroundClaimed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        return { runId: "recovery-run", status: "accepted" };
      }
      if (!foregroundClaimed) {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey: "agent:main:main", storePath },
        });
        expect(owner.kind).toBe("claimed");
        foregroundClaimed = true;
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { recovered: 0, failed: 1, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      status: "running",
      mainRestartRecovery: {
        foregroundClaims: { tokens: [expect.any(String)] },
      },
    });
  });

  it("settles a reused recovery RPC after its dispatch wait times out", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("gateway request timeout for agent"))
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "ok",
        endedAt: Date.now(),
      });

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(vi.mocked(callGateway).mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "recovery-run", timeoutMs: 0 },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      status: "done",
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
    ).toBeUndefined();
  });

  it("does not deliver restart recovery when session send policy denies sends", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    await writeCompletedToolTranscript(sessionsDir);

    const result = await recoverRestartAbortedMainSessions({
      cfg: { session: { sendPolicy: { default: "deny" } } },
      stateDir: tmpDir,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams().deliver).toBe(false);
  });

  it("fails marked sessions with stale approval-pending exec tool results", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
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

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a durable pending final delivery payload (Phase 2)", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = "The final answer is 42.";
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: pendingPayload,
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryDeliveryRunId: "discord-message-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoverySourceIngress: "channel",
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
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});
    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({
      deliver: true,
      bestEffortDeliver: true,
      channel: "discord",
      to: "discord:dm:final",
      accountId: "main",
      forceRestartSafeTools: true,
    });
    expect(gatewayParams().message).toContain(pendingPayload);

    const beforeStoreRead = Date.now();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.pendingFinalDelivery).toBe(true);
    expect(entry?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(entry?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(entry?.pendingFinalDeliveryLastError).toBeNull();
    expect(entry?.restartRecoveryForceSafeTools).toBe(true);
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt ?? 0).toBeGreaterThanOrEqual(
      entry?.pendingFinalDeliveryCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps a hook-owned pending final behind the unsafe-hook gate after claim cleanup", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    runtimePluginMocks.findRestartRecoveryUnsafeReplyHook.mockReturnValue("before_message_write");
    await writeMainSession({
      sessionsDir,
      sessionKey,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "hook reply",
      pendingFinalDeliveryContext: {
        channel: "discord",
        to: "discord:dm:123",
      },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "answer from the hook" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 }, {});

    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "message.action",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("retains restart safety when the first restart follows pending final persistence", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "Safe work finished.",
      pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "completed", value: "done", replaySafe: true }),
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Safe work finished." }] },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryForceSafeTools).toBe(true);
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
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: pendingPayload,
      pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The final answer is 42.");
    expect(gatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(gatewayParams().message).not.toContain("Conversation info");

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe("The final answer is 42.");
  });

  it("resumes an unguarded pending final delivery without a transcript", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("missing-transcript-session"),
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "The durable final answer.",
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The durable final answer.");
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("resumes pending final delivery even when the transcript tail is assistant output", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "assistant final was already captured",
      pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish" },
      { role: "assistant", content: "assistant final was already captured" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().message).toContain("assistant final was already captured");
    const store = readStore(path.join(sessionsDir, "sessions.json"));
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
        ...runningSessionEntry("main-session"),
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        ...runningSessionEntry("active-key-session"),
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        ...runningSessionEntry("active-id-session"),
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        ...runningSessionEntry("recoverable-session"),
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
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("stale-session"),
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
    const store = readStore(path.join(sessionsDir, "sessions.json"));
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
    let store = readStore(path.join(sessionsDir, "sessions.json"));
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
    store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
  });

  it.each([
    ["current owner before delayed stale registration", "current-first"],
    ["stale owner before current registration", "stale-first"],
  ] as const)("keeps a live session running with %s", async (_label, registrationOrder) => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });

    const createHandle = (runId: string): EmbeddedAgentQueueHandle => ({
      kind: "embedded",
      runId,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    });
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleHandle = createHandle("stale-generation-run");
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);
    if (registrationOrder === "stale-first") {
      setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }

    rotateAgentEventLifecycleGeneration();
    const currentHandle = createHandle("current-generation-run");
    setActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
    if (registrationOrder === "current-first") {
      setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }

    try {
      await expect(
        recoverStartupOrphanedMainSessions({ stateDir: tmpDir, updatedBeforeMs: cutoff }),
      ).resolves.toEqual({ marked: 0, recovered: 0, failed: 0, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({
          sessionKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        }),
      ).toMatchObject({ status: "running" });
    } finally {
      clearActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
      clearActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }
  });

  it("reconciles only prior-lifecycle running sessions after an in-process restart", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const abandonedKey = "agent:main:abandoned-client";
    const liveKey = "agent:main:live-client";
    await writeStore(sessionsDir, {
      [abandonedKey]: {
        sessionId: "abandoned-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      [liveKey]: {
        sessionId: "live-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "abandoned-session", [
      { role: "system", content: "the client disappeared before the turn became resumable" },
    ]);

    const createHandle = (
      runId: string,
      queueMessage: EmbeddedAgentQueueHandle["queueMessage"] = async () => {},
      abort: EmbeddedAgentQueueHandle["abort"] = () => {},
    ): EmbeddedAgentQueueHandle => ({
      kind: "embedded",
      runId,
      queueMessage,
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    });
    const abandonedReply = createReplyOperation({
      sessionKey: abandonedKey,
      sessionId: "abandoned-session",
      resetTriggered: false,
    });
    const abandonedReplyQueue = vi.fn(async () => {});
    const abandonedReplyCancel = vi.fn();
    abandonedReply.setPhase("running");
    abandonedReply.attachBackend({
      kind: "embedded",
      cancel: abandonedReplyCancel,
      isStreaming: () => true,
      queueMessage: abandonedReplyQueue,
    });
    const abandonedEmbeddedQueue = vi.fn(async () => {});
    const abandonedEmbeddedAbort = vi.fn();
    const abandonedHandle = createHandle(
      "abandoned-run",
      abandonedEmbeddedQueue,
      abandonedEmbeddedAbort,
    );
    setActiveEmbeddedRun("abandoned-session", abandonedHandle, abandonedKey);

    const firstRecovery = recoverStartupOrphanedMainSessions({
      stateDir: tmpDir,
      updatedBeforeMs: cutoff,
    });
    // Advance ownership while the async store discovery above is pending. The
    // older scan must drop the stale owner without overlooking this new live one.
    rotateAgentEventLifecycleGeneration();
    setActiveEmbeddedRun("abandoned-session", abandonedHandle, abandonedKey);

    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync("abandoned-session", "do not route stale"),
    ).resolves.toMatchObject({ queued: false, reason: "no_active_run" });
    expect(abandonedEmbeddedQueue).not.toHaveBeenCalled();
    expect(abandonedEmbeddedAbort).toHaveBeenCalledWith("restart");
    expect(abandonedReplyQueue).not.toHaveBeenCalled();
    expect(abandonedReplyCancel).toHaveBeenCalledWith("restart");
    expect(resolveActiveEmbeddedRunHandleSessionId(abandonedKey)).toBeUndefined();

    const liveReply = createReplyOperation({
      sessionKey: liveKey,
      sessionId: "live-session",
      resetTriggered: false,
    });
    const liveAbort = vi.fn();
    const liveHandle = createHandle("live-run", undefined, liveAbort);
    setActiveEmbeddedRun("live-session", liveHandle, liveKey);
    try {
      const first = await firstRecovery;

      expect(first).toEqual({ marked: 1, recovered: 0, failed: 1, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({
          sessionKey: abandonedKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        }),
      ).toMatchObject({
        status: "failed",
        abortedLastRun: true,
      });
      expect(
        loadSessionEntry({
          sessionKey: liveKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        }),
      ).toMatchObject({
        status: "running",
      });
      expect(liveAbort).not.toHaveBeenCalled();
      expect(liveReply.abortSignal.aborted).toBe(false);

      await expect(
        recoverStartupOrphanedMainSessions({ stateDir: tmpDir, updatedBeforeMs: cutoff }),
      ).resolves.toEqual({ marked: 0, recovered: 0, failed: 0, skipped: 0 });
    } finally {
      clearActiveEmbeddedRun("abandoned-session", abandonedHandle, abandonedKey);
      clearActiveEmbeddedRun("live-session", liveHandle, liveKey);
      abandonedReply.complete();
      liveReply.complete();
    }
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
    await writeStorePath(customStorePath, {
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
    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("admits each scheduled recovery attempt as independent root work", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "interrupted response",
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
        return { runId: "run-resumed", status: "timeout" };
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed" };
      });

    scheduleRestartAbortedMainSessionRecovery({
      cfg: {},
      delayMs: 0,
      maxRetries: 2,
      stateDir: tmpDir,
    });

    await waitForFast(() => {
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(suspensionRef.current?.release()).toBe(true);

    await waitForFast(() => {
      expect(callGateway).toHaveBeenCalledTimes(3);
      const entry = loadSessionEntry({
        storePath: path.join(sessionsDir, "sessions.json"),
        sessionKey: "agent:main:main",
      });
      expect(entry?.abortedLastRun).toBe(false);
    });
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(new Set(runIds).size).toBe(1);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("retries only the requested abandoned durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...mainSessionEntry(),
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
        restartRecoverySourceIngress: "channel",
        restartRecoverySourceReplyDeliveryMode: "message_tool_only",
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:main",
          accountId: "work",
        },
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-other",
        restartRecoveryDeliverySourceRunId: "source-other",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only me" },
    ]);
    await writeTranscript(sessionsDir, "other-session", [
      { role: "user", content: "leave me pending" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().idempotencyKey).toBe("recovery-main");
    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "main-session",
      internalRuntimeHandoffId: expect.any(String),
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
      deliver: false,
      channel: "discord",
      to: "discord:dm:main",
      accountId: "work",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-main",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-other",
    });
  });

  it("retries only the exact interrupted row released by its final foreground owner", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...mainSessionEntry(),
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
        abortedLastRun: true,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    await writeTranscript(sessionsDir, "other-session", [
      { role: "user", content: "leave this row pending" },
    ]);

    const result = await retryRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
    });
    expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "main-session"])).toBe(
      false,
    );
  });

  it("retries an exact legacy row after its canonical alias is reused", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "replacement-session",
        updatedAt: Date.now(),
      },
      main: {
        sessionId: "legacy-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "legacy-session", [
      { role: "user", content: "resume the legacy row" },
    ]);

    const result = await retryRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      expectedSessionId: "legacy-session",
      sessionKey: "main",
      storePath,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "legacy-session",
      sessionKey: "main",
    });
    expect(
      sessionAccessor.loadExactSessionEntry({ sessionKey: "main", storePath })?.entry,
    ).toMatchObject({
      sessionId: "legacy-session",
      abortedLastRun: false,
    });
    expect(
      sessionAccessor.loadExactSessionEntry({ sessionKey: "agent:main:main", storePath })?.entry,
    ).toMatchObject({ sessionId: "replacement-session" });
  });

  it("retries a failed exact owner-release recovery with bounded backoff", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries: 2,
      sessionKey: "agent:main:main",
      storePath,
    });

    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("tombstones exhausted recovery with replacement-session instructions", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-exhausted",
          revision: 1,
          chargedAttempts: 3,
        },
        restartRecoveryDeliveryContext: discordDeliveryContext,
      },
    });

    await expectRecovery({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          params: expect.objectContaining({ message: expect.stringContaining("/new or /reset") }),
        }),
      }),
    );
    expect(
      loadSessionEntry({ sessionKey: "agent:main:discord:direct:123", storePath }),
    ).toMatchObject({
      status: "failed",
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("rejects foreground takeover while tombstoning exhausted recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
    const appendAssistantMessageToSessionTranscript =
      transcriptMocks.appendAssistantMessageToSessionTranscript.getMockImplementation();
    if (!appendAssistantMessageToSessionTranscript) {
      throw new Error("expected transcript append implementation");
    }
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(
      async (params) => {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey, storePath },
        });
        expect(owner).toEqual({ kind: "invalidated", reason: "recovery_exhausted" });
        return await appendAssistantMessageToSessionTranscript(params);
      },
    );

    await expectRecovery({ recovered: 0, failed: 0, skipped: 1 });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
    const notices = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "main-session",
        sessionKey,
        storePath,
      })
    ).filter((event) => {
      const record = event as { type?: unknown; message?: { idempotencyKey?: unknown } };
      return (
        record.type === "message" &&
        typeof record.message?.idempotencyKey === "string" &&
        record.message.idempotencyKey.endsWith(":failed-notice")
      );
    });
    expect(notices).toHaveLength(1);
  });

  it("retries tombstoning after a transcript metadata conflict", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session metadata changed",
    });

    await expectRecovery({ recovered: 0, failed: 0, skipped: 1 });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("tombstones when the final owner-release retry consumes the last charge", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      mainRestartRecovery: {
        cycleId: "cycle-final-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("final ambiguous dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" });

    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries: 1,
      sessionKey: "agent:main:main",
      storePath,
    });

    await waitForFast(() => {
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "failed",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("tombstones when the final startup retry consumes the last charge", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      mainRestartRecovery: {
        cycleId: "cycle-final-startup-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "interrupted response",
    });
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        await replaceSessionEntry({ sessionKey: "agent:main:fresh", storePath }, {
          sessionId: "fresh-session",
          updatedAt: Date.now(),
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-fresh-exhausted",
            revision: 1,
            chargedAttempts: 3,
          },
        } as SessionEntry);
        throw new Error("final ambiguous dispatch failure");
      })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    scheduleRestartAbortedMainSessionRecovery({
      cfg: {},
      delayMs: 0,
      maxRetries: 1,
      stateDir: tmpDir,
    });

    await waitForFast(() => {
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "failed",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
    const freshEntry = loadSessionEntry({ sessionKey: "agent:main:fresh", storePath });
    expect(freshEntry).toMatchObject({
      sessionId: "fresh-session",
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 3 },
    });
    expect(freshEntry?.mainRestartRecovery?.tombstone).toBeUndefined();
  });

  it("fails closed when message-tool-only authority cannot be reconstructed", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:main",
        accountId: "work",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only with delivery authority" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const [gatewayRequest] = vi.mocked(callGateway).mock.calls[0] ?? [];
    expect(gatewayRequest?.method).toBe("message.action");
    expect(gatewayRequest?.params).toMatchObject({
      action: "send",
      accountId: "work",
      channel: "discord",
      params: {
        to: "discord:dm:main",
        message: expect.stringContaining("couldn't safely resume"),
      },
    });
    const failedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(failedEntry).toMatchObject({
      abortedLastRun: true,
      status: "failed",
    });
    expect(failedEntry?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(failedEntry?.restartRecoverySourceReplyDeliveryMode).toBeUndefined();
  });

  it("does not restore channel authority from a generic session route", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      channel: "discord",
      lastTo: "discord:dm:fallback",
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do not inherit a fallback route" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(events.at(-1)).toMatchObject({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: expect.stringContaining("couldn't safely resume"),
          },
        ],
      },
    });
  });

  it("dispatches an abandoned durable claim through its owning Gateway instance", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover without a socket" },
    ]);
    const dispatchAgent = vi.fn(async () => ({ runId: "recovery-main", status: "accepted" }));

    const result = await retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
      gatewayRuntime: {
        dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
        waitForAgent: vi.fn(),
        sendRecoveryNotice: vi.fn(),
      },
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "recovery-main",
        sessionKey: "agent:main:main",
      }),
      10_000,
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("targets a legacy durable row through its canonical agent session key", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      main: {
        sessionId: "legacy-main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "legacy-recovery",
        restartRecoveryDeliverySourceRunId: "legacy-source",
      },
    });
    await writeTranscript(sessionsDir, "legacy-main-session", [
      { role: "user", content: "recover the legacy row" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      canonicalSessionKey: "agent:main:main",
      cfg: {},
      expectedRecoveryRunId: "legacy-recovery",
      expectedRecoverySourceRunId: "legacy-source",
      expectedSessionId: "legacy-main-session",
      sessionKey: "main",
      storePath,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "legacy-main-session",
      idempotencyKey: "legacy-recovery",
      internalRuntimeHandoffId: expect.any(String),
      sessionKey: "agent:main:main",
    });
    // The gateway mock stops before agent admission, which promotes this alias
    // to the canonical key before the recovered run can execute message tools.
    expect(
      sessionAccessor.loadExactSessionEntry({ sessionKey: "main", storePath })?.entry,
    ).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "legacy-recovery",
      restartRecoveryDeliverySourceRunId: "legacy-source",
    });
  });

  it("holds lifecycle replacement behind the targeted recovery dispatch", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "main-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      },
    });
    await writeTranscript(sessionsDir, sessionId, [{ role: "user", content: "recover me" }]);
    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { runId: "recovery-main" };
    });

    const recovery = retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: sessionId,
      sessionKey,
      storePath,
    });
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
      mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          expect(
            await interruptSessionWorkAdmissions({
              scope: storePath,
              identities: [sessionKey, sessionId],
              timeoutMs: 1_000,
            }),
          ).toBe(true);
        },
        run: async () => {
          mutationRan = true;
        },
      });
      await waitForFast(() =>
        expect(isSessionLifecycleMutationActive(storePath, [sessionKey, sessionId])).toBe(true),
      );
      expect(mutationRan).toBe(false);

      releaseDispatch.resolve();
      await expect(recovery).resolves.toEqual({ recovered: 1, failed: 0, skipped: 0 });
      await mutation;
      expect(mutationRan).toBe(true);
    } finally {
      releaseDispatch.resolve();
      await Promise.allSettled([recovery, ...(mutation ? [mutation] : [])]);
    }
  });

  it("does not retry a replacement durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("replacement-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "replacement-recovery",
        restartRecoveryDeliverySourceRunId: "replacement-source",
      },
    });
    await writeTranscript(sessionsDir, "replacement-session", [
      { role: "user", content: "replacement turn" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      expectedRecoveryRunId: "stale-recovery",
      expectedRecoverySourceRunId: "stale-source",
      expectedSessionId: "stale-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "replacement-recovery",
      restartRecoveryDeliverySourceRunId: "replacement-source",
      sessionId: "replacement-session",
    });
  });

  it("does not dispatch an archived durable recovery claim", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "archived-session",
        updatedAt: Date.now() - 10_000,
        archivedAt: Date.now() - 5_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "archived-recovery",
        restartRecoveryDeliverySourceRunId: "archived-source",
      },
    });
    await writeTranscript(sessionsDir, "archived-session", [
      { role: "user", content: "do not recover while archived" },
    ]);

    await expectRecovery({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails marked sessions without a meaningful transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "system", content: "session metadata only" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("completes an interrupted turn whose exact terminal source reply was delivered", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        startedAt: Date.now() - 20_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryBeforeAgentReplyState: "pending",
        pendingFinalDeliveryIntentId: "pending-1",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-1",
          name: "message",
          arguments: { action: "send", message: "delivered answer" },
        },
      ]),
      {
        role: "assistant",
        content: [{ type: "text", text: "delivered answer" }],
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId: "discord-message-1",
          toolCallId: "message-call-1",
        },
      },
      {
        role: "toolResult",
        toolCallId: "message-call-1",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const completed = loadSessionEntry({ sessionKey, storePath });
    expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(completed?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(completed?.pendingFinalDelivery).toBeUndefined();
    expect(completed?.pendingFinalDeliveryText).toBeUndefined();
    expect(completed?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("resumes after an unhandled before_agent_reply hook checkpoint", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "continue",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoverySourceIngress: "channel",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});

    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({ method: "agent" });
    expect(gatewayParams()).toMatchObject({ deliver: true });
  });

  it.each([
    {
      name: "fails a checkpointed channel recovery when before_agent_reply is active after restart",
      sessionKey: "agent:main:discord:direct:123",
      hook: "before_agent_reply",
      checkpoint: true,
      channelIngress: true,
      sourceOwned: true,
      content: "do the thing",
    },
    {
      name: "fails a checkpointed transcript-only recovery when another unsafe reply hook is active",
      sessionKey: "agent:main:main",
      hook: "before_message_write",
      checkpoint: true,
      channelIngress: false,
      sourceOwned: false,
      content: "do the transcript-only thing",
    },
    {
      name: "fails a channel recovery when before_agent_reply was never checkpointed",
      sessionKey: "agent:main:discord:direct:123",
      hook: "before_agent_reply",
      checkpoint: false,
      channelIngress: true,
      sourceOwned: true,
      content: "do the thing",
    },
    {
      name: "fails a legacy external recovery without source ownership when a hook is active",
      sessionKey: "agent:main:discord:direct:123",
      hook: "before_agent_reply",
      checkpoint: false,
      channelIngress: false,
      sourceOwned: true,
      content: "do the legacy thing",
    },
  ])("$name", async ({ sessionKey, hook, checkpoint, channelIngress, sourceOwned, content }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    runtimePluginMocks.findRestartRecoveryUnsafeReplyHook.mockReturnValue(hook);
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...(checkpoint ? { restartRecoveryBeforeAgentReplyState: "continue" as const } : {}),
      restartRecoveryDeliveryRunId: "recovery-1",
      ...(sourceOwned ? { restartRecoveryDeliverySourceRunId: "discord-message-1" } : {}),
      ...(channelIngress ? { restartRecoverySourceIngress: "channel" as const } : {}),
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content,
        ...(sourceOwned ? { idempotencyKey: "discord-message-1" } : {}),
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 }, {});

    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "message.action",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });
  it("resumes a Control UI turn after proving the current runtime is hookless", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "admitted",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "control-ui",
    });
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content: "do the thing",
        idempotencyKey: "control-ui-run:user",
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 }, {});

    expect(runtimePluginMocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, allowGatewaySubagentBinding: true }),
    );
    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({ method: "agent" });
    expect(gatewayParams()).toMatchObject({
      deliver: false,
      sessionKey,
    });
  });

  it("fails a pre-hook Control UI recovery when a runtime hook is active", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    runtimePluginMocks.findRestartRecoveryUnsafeReplyHook.mockReturnValue("before_agent_reply");
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "admitted",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "control-ui",
    });
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content: "do the thing",
        idempotencyKey: "control-ui-run:user",
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 }, {});

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: true,
    });
  });

  it("keeps an adopted Control UI turn behind the unsafe hook gate", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    runtimePluginMocks.findRestartRecoveryUnsafeReplyHook.mockReturnValue("before_message_write");
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "continue",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "control-ui",
    });
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content: "do the thing",
        idempotencyKey: "control-ui-run:user",
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 }, {});

    expect(runtimePluginMocks.findRestartRecoveryUnsafeReplyHook).toHaveBeenCalledOnce();
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("fails closed while a terminal provider outcome remains unknown", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "continue",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "message.action",
    });
    const failed = loadSessionEntry({ sessionKey, storePath });
    expect(failed?.status).toBe("failed");
    expect(failed?.restartRecoveryDeliveryReceiptState).toBeUndefined();
  });

  it("completes from a durable terminal provider receipt without replaying", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry(),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-1",
          name: "message",
          arguments: { action: "send", message: "delivered answer" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(transcript.map((event) => event.message).filter(Boolean)).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "message-call-1",
        toolName: "message",
        isError: false,
      }),
    );
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("reconciles a receipt delivered during a restart-recovery continuation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry("message-call-recovered", "discord-message-1"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      {
        role: "assistant",
        content: [{ type: "text", text: "starting" }],
      },
      {
        role: "user",
        content: "[System] continue after restart",
        idempotencyKey: "recovery-1:user",
      },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-recovered",
          name: "message",
          arguments: { action: "send", message: "delivered answer" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .some(
          (message) =>
            message?.idempotencyKey ===
            "restart-recovery:message-tool-result:discord-message-1:message-call-recovered",
        ),
    ).toBe(true);
  });

  it.each([
    {
      label: "empty restart-abort artifact",
      content: [],
      expected: { recovered: 1, failed: 0, skipped: 0 },
      expectedStatus: "done",
      gatewayCalls: 0,
      recoveredResult: true,
    },
    {
      label: "restart-abort artifact with partial output",
      content: [{ type: "text", text: "partial answer" }],
      expected: { recovered: 0, failed: 1, skipped: 0 },
      expectedStatus: "failed",
      gatewayCalls: 1,
      recoveredResult: false,
    },
  ] as const)(
    "reconciles a delivered terminal receipt through $label",
    async ({ content, expected, expectedStatus, gatewayCalls, recoveredResult }) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:discord:direct:123";
      await writeStore(sessionsDir, {
        [sessionKey]: {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
          ...deliveredReceiptEntry(),
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "message-call-1",
            name: "message",
            arguments: { action: "send", message: "delivered answer" },
          },
        ]),
        {
          role: "assistant",
          content,
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        },
      ]);

      await expect(recoverRestartAbortedMainSessions({ stateDir: tmpDir })).resolves.toEqual(
        expected,
      );

      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe(expectedStatus);
      const transcript = await loadTestTranscript(sessionKey, storePath);
      expect(
        transcript
          .map((event) => event.message)
          .some(
            (message) =>
              message?.idempotencyKey ===
              "restart-recovery:message-tool-result:discord-message-1:message-call-1",
          ),
      ).toBe(recoveredResult);
    },
  );

  it.each([
    ["error", { toolName: "message", isError: true }],
    ["different-tool", { toolName: "other", isError: false }],
  ] as const)(
    "fails closed on an existing %s result instead of duplicating it",
    async (_label, existingResult) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:discord:direct:123";
      await writeStore(sessionsDir, {
        [sessionKey]: {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
          ...deliveredReceiptEntry(),
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "message-call-1",
            name: "message",
            arguments: { action: "send", message: "delivered answer" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "message-call-1",
          content: [{ type: "text", text: "transport reported failure" }],
          ...existingResult,
        },
      ]);

      await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

      const transcript = await loadTestTranscript(sessionKey, storePath);
      const results = transcript
        .map((event) => event.message)
        .filter(
          (message) => message?.role === "toolResult" && message.toolCallId === "message-call-1",
        );
      expect(results).toHaveLength(1);
      expect(
        transcript
          .map((event) => event.message)
          .some(
            (message) =>
              message?.idempotencyKey ===
              "restart-recovery:message-tool-result:discord-message-1:message-call-1",
          ),
      ).toBe(false);
      expect(callGateway).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
    },
  );

  it("fails a delivered receipt without its owning message tool call", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry(),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
    const transcript = await loadTranscriptEvents({
      sessionId: "main-session",
      sessionKey,
      storePath,
    });
    expect(
      transcript.some(
        (event) => (event as { message?: Record<string, unknown> }).message?.role === "toolResult",
      ),
    ).toBe(false);
  });

  it("fails a delivered receipt that lacks its durable source turn", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry("message-call-1", "discord-message-missing"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-1",
          name: "message",
          arguments: { action: "send", message: "delivered answer" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "message.action",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: true,
    });
  });

  it("fails closed instead of appending a recovered result after later turns", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    const recoveryEntry: SessionEntry = {
      sessionId: "main-session",
      updatedAt: Date.now() - 10_000,
      status: "running",
      abortedLastRun: true,
      ...deliveredReceiptEntry("message-call-reused", "discord-message-current"),
    };
    await writeStore(sessionsDir, {
      [sessionKey]: recoveryEntry,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "old turn", idempotencyKey: "discord-message-old" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-reused",
          name: "message",
          arguments: { action: "send", message: "old answer" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "message-call-reused",
        toolName: "message",
        content: [{ type: "text", text: "old sent" }],
      },
      {
        role: "user",
        content: "current turn",
        idempotencyKey: "discord-message-current",
      },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-reused",
          name: "message",
          arguments: { action: "send", message: "current answer" },
        },
      ]),
      { role: "user", content: "later turn", idempotencyKey: "discord-message-later" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-reused",
          name: "message",
          arguments: { action: "send", message: "later answer" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "message-call-reused",
        toolName: "message",
        content: [{ type: "text", text: "later sent" }],
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    const transcript = await loadTestTranscript(sessionKey, storePath);
    const matchingResults = transcript
      .map((event) => event.message)
      .filter(
        (message) => message?.role === "toolResult" && message.toolCallId === "message-call-reused",
      );
    expect(matchingResults).toHaveLength(2);
    expect(
      transcript
        .map((event) => event.message)
        .some(
          (message) =>
            message?.idempotencyKey ===
            "restart-recovery:message-tool-result:discord-message-current:message-call-reused",
        ),
    ).toBe(false);
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("fails closed when an existing successful result belongs to an earlier turn", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry("message-call-current", "discord-message-current"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current turn", idempotencyKey: "discord-message-current" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-current",
          name: "message",
          arguments: { action: "send", message: "current answer" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "message-call-current",
        toolName: "message",
        isError: false,
        content: [{ type: "text", text: "sent" }],
      },
      { role: "user", content: "later turn", idempotencyKey: "discord-message-later" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .filter(
          (message) =>
            message?.role === "toolResult" && message.toolCallId === "message-call-current",
        ),
    ).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("fails closed when a successful message result is followed by unfinished tool work", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry("message-call-current", "discord-message-current"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current turn", idempotencyKey: "discord-message-current" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-current",
          name: "message",
          arguments: { action: "send", message: "current answer" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "message-call-current",
        toolName: "message",
        isError: false,
        content: [{ type: "text", text: "sent" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "pending-write", name: "write", arguments: {} }],
        stopReason: "toolUse",
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .filter(
          (message) =>
            message?.role === "toolResult" && message.toolCallId === "message-call-current",
        ),
    ).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("fails closed when a delivered message shares an assistant event with unfinished tool work", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      ...deliveredReceiptEntry("message-call-current", "discord-message-current"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current turn", idempotencyKey: "discord-message-current" },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "message-call-current",
          name: "message",
          arguments: { action: "send", message: "current answer" },
        },
        { type: "toolCall", id: "pending-write", name: "write", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "message-call-current",
        toolName: "message",
        isError: false,
        content: [{ type: "text", text: "sent" }],
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .filter(
          (message) =>
            message?.role === "toolResult" && message.toolCallId === "message-call-current",
        ),
    ).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it.each([
    {
      label: "terminal silent reply",
      finalText: "NO_REPLY",
      expected: { recovered: 1, failed: 0, skipped: 0 },
      expectedStatus: "done",
      gatewayCalls: 0,
    },
    {
      label: "visible assistant reply",
      finalText: "another answer",
      expected: { recovered: 0, failed: 1, skipped: 0 },
      expectedStatus: "failed",
      gatewayCalls: 1,
    },
  ] as const)(
    "reconciles a successful message result followed by $label",
    async ({ finalText, expected, expectedStatus, gatewayCalls }) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:discord:direct:123";
      await writeStore(sessionsDir, {
        [sessionKey]: {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
          ...deliveredReceiptEntry("message-call-current", "discord-message-current"),
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "current turn", idempotencyKey: "discord-message-current" },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "message-call-current",
            name: "message",
            arguments: { action: "send", message: "delivered answer" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "message-call-current",
          toolName: "message",
          isError: false,
          content: [{ type: "text", text: "sent" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
        },
      ]);

      await expect(recoverRestartAbortedMainSessions({ stateDir: tmpDir })).resolves.toEqual(
        expected,
      );

      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe(expectedStatus);
    },
  );

  it("completes a checkpointed silent before_agent_reply result without dispatch", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
  });

  it("matches a checkpointed Control UI hook to its run-keyed user turn", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "quiet", idempotencyKey: "control-ui-run:user" },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["control-ui-run"],
    });
  });

  it("does not let a silent checkpoint complete over a later user turn", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current turn", idempotencyKey: "discord-message-1" },
      { role: "user", content: "later turn", idempotencyKey: "discord-message-2" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });

  it("fails closed for a source-less silent before_agent_reply checkpoint", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:custom:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [{ role: "user", content: "quiet" }]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    const failed = loadSessionEntry({ sessionKey, storePath });
    expect(failed).toMatchObject({ status: "failed", abortedLastRun: true });
    expect(failed?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(failed?.restartRecoveryTerminalRunIds).toBeUndefined();
  });

  it.each(["pending", "handled-reply", "handled-unrecoverable"] as const)(
    "fails closed for a %s before_agent_reply checkpoint without a recoverable result",
    async (restartRecoveryBeforeAgentReplyState) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:discord:direct:123";
      await writeStore(sessionsDir, {
        [sessionKey]: {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
          restartRecoveryBeforeAgentReplyState,
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "discord-message-1",
          restartRecoveryDeliveryContext: discordDeliveryContext,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      ]);

      await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

      expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
        method: "message.action",
      });
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
    },
  );

  it.each([
    ["progress delivery", false, "discord-message-1"],
    ["an older turn's terminal delivery", true, "discord-message-0"],
  ])("does not complete from %s", async (_label, final, sourceTurnId) => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "not this turn's terminal answer" }],
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final,
          sourceTurnId,
          toolCallId: "message-call-1",
        },
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "completed assistant output",
      {
        role: "assistant",
        content: [{ type: "text", text: "finished answer" }],
        stopReason: "stop",
      },
    ],
    [
      "errored assistant output",
      {
        role: "assistant",
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
      },
    ],
    [
      "aborted tool call",
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
        stopReason: "aborted",
      },
    ],
    [
      "aborted assistant output with text",
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
      },
    ],
  ])("does not resume %s at the transcript tail", async (_label, assistantMessage) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      assistantMessage,
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps an unresumable Control UI notice in history despite a stale external route", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      lastChannel: "whatsapp",
      lastTo: "+15551234567",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            idempotencyKey: "main-session-restart-recovery:control-ui-run:failed-notice",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("couldn't safely resume"),
              }),
            ]),
          }),
        }),
      ]),
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      restartRecoveryTerminalRunIds: ["control-ui-run"],
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
    ).toBeUndefined();

    const failedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    if (!failedEntry) {
      throw new Error("expected failed recovery entry");
    }
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      {
        ...failedEntry,
        status: "running",
        abortedLastRun: true,
        endedAt: undefined,
        restartRecoveryDeliveryRunId: "control-ui-run-2",
        restartRecoveryDeliverySourceRunId: "control-ui-run-2",
        updatedAt: Date.now(),
      },
    );
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do another thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "another partial answer" }],
        stopReason: "aborted",
      },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    const noticeIds = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      })
    )
      .map((event) => {
        const record = event as {
          type?: unknown;
          message?: { idempotencyKey?: unknown };
        };
        return record.type === "message" && typeof record.message?.idempotencyKey === "string"
          ? record.message.idempotencyKey
          : undefined;
      })
      .filter((id): id is string => id?.endsWith(":failed-notice") === true);
    expect(noticeIds).toEqual([
      "main-session-restart-recovery:control-ui-run:failed-notice",
      "main-session-restart-recovery:control-ui-run-2:failed-notice",
    ]);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      restartRecoveryTerminalRunIds: ["control-ui-run", "control-ui-run-2"],
    });
  });

  it("keeps an unresumable Control UI claim recoverable until its notice is durable", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
      },
    ]);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      reason: "simulated SQLite write failure",
    });

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      restartRecoveryTerminalRunIds: ["control-ui-run"],
    });
    const notices = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      })
    ).filter((event) => {
      const record = event as { type?: unknown; message?: { idempotencyKey?: unknown } };
      return (
        record.type === "message" &&
        record.message?.idempotencyKey ===
          "main-session-restart-recovery:control-ui-run:failed-notice"
      );
    });
    expect(notices).toHaveLength(1);
  });

  it("fails the interrupted owner before unresumable external notice delivery", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("interrupted-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "interrupted-run",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      },
    });
    await writeTranscript(sessionsDir, "interrupted-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
      },
    ]);
    let entryAtExternalSend: SessionEntry | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      entryAtExternalSend = loadSessionEntry({ sessionKey, storePath });
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "replacement-session",
          updatedAt: Date.now(),
          status: "running",
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: "replacement-run",
          restartRecoveryDeliverySourceRunId: "replacement-source",
        },
      );
      return { status: "ok" };
    });

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });

    expect(entryAtExternalSend).toMatchObject({
      sessionId: "interrupted-session",
      status: "failed",
    });
    expect(entryAtExternalSend?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entryAtExternalSend?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "replacement-session",
      status: "running",
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "replacement-run",
      restartRecoveryDeliverySourceRunId: "replacement-source",
    });
  });

  it("sends a visible notice through the canonical route when no resumable transcript survives", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "discord",
            to: "discord:channel:room-1",
            accountId: "default",
            threadId: "thread-1",
          },
        }),
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "system", content: "session metadata only" },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | {
          method?: string;
          params?: Record<string, unknown>;
        }
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

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("failed");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:demo-channel:room-1"]?.mainRestartRecovery).toBeUndefined();
  });

  it("resumes a restart interrupted at the Code Mode wait control", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:channel:room-1",
          accountId: "default",
          threadId: "thread-1",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              reason: "yield",
              replaySafe: true,
            }),
          },
        ],
      },
      createAssistantToolCallMessage([
        { type: "thinking", thinking: "The read-only work is still pending." },
        { type: "text", text: "" },
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | {
          method?: string;
          params?: Record<string, unknown>;
        }
      | undefined;
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params).toMatchObject({
      message: expect.stringContaining("Continue from the existing transcript"),
      deliver: true,
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffortDeliver: true,
      forceRestartSafeTools: true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("running");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:demo-channel:room-1"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("reads a provider-native Code Mode wait input", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        {
          type: "tool_use",
          id: "call-wait-1",
          name: "wait",
          input: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each([
    {
      replaySafe: true,
      expected: { recovered: 1, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      replaySafe: false,
      expected: { recovered: 0, failed: 1, skipped: 0 },
      gatewayCalls: 0,
    },
  ])(
    "classifies a direct waiting checkpoint with replaySafe=$replaySafe",
    async ({ replaySafe, expected, gatewayCalls }) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "waiting",
                runId: "cm_interrupted",
                replaySafe,
              }),
            },
          ],
        },
      ]);

      await expectRecovery(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      if (replaySafe) {
        expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it.each(["completed", "failed"] as const)(
    "keeps restart safety after a terminal Code Mode %s result",
    async (status) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "wait",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status,
                replaySafe: true,
                ...(status === "completed" ? { value: "done" } : { error: "safe failure" }),
              }),
            },
          ],
        },
      ]);

      await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("keeps restart safety across a second restart of the recovery turn", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "user",
        content:
          "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
      },
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "call-read-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ]),
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "read result" }],
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps restart safety after the recovery prompt leaves the recent transcript window", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      ...Array.from({ length: 24 }, (_, index) => ({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: `read result ${index}` }],
      })),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an in-flight safe tool call across a repeated restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      createAssistantToolCallMessage([
        { type: "thinking", thinking: "I need one more read." },
        { type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("does not resume completed assistant output just because the restart-safe guard remains", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "Done already." }] },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not treat a historical recovery prompt as current recovery state", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content:
          "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
      },
      { role: "assistant", content: [{ type: "text", text: "Finished that recovery." }] },
      { role: "user", content: "a later request" },
      { role: "assistant", content: [{ type: "text", text: "Finished the later request." }] },
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not replay visible assistant text beside a Code Mode wait", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        { type: "text", text: "I already sent this part." },
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "empty provider abort artifact",
      content: [],
      expected: { recovered: 1, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      label: "provider abort artifact with partial output",
      content: [{ type: "text", text: "partial answer" }],
      expected: { recovered: 1, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
  ])(
    "handles $label without discarding assistant output",
    async ({ content, expected, gatewayCalls }) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          ...runningSessionEntry("main-session"),
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        codeModeWaitCallMessage(),
        {
          role: "assistant",
          content,
          stopReason: "error",
          errorMessage: "Request was aborted",
        },
      ]);

      await expectRecovery(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("resumes a partial streamed answer interrupted by a restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the first half of the answer" }],
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an abort artifact persisted with the gateway restart reason", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "agent run aborted for restart",
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("resumes a side-effecting tool call restricted to restart-safe tools", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      createAssistantToolCallMessage([
        { type: "text", text: "Running the check now." },
        { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps a dangling side-effecting call in an aborted tail restricted", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Kicking that off." },
          { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
        ],
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an interrupted replay-safe tool call without restricting tools", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      createAssistantToolCallMessage([
        { type: "text", text: "Let me look that up." },
        { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "README.md" } },
      ]),
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes through the shutdown error persisted for an interrupted Code Mode wait", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-wait-1",
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps an unmatched failed wait restricted when its checkpoint is replay-safe", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-other",
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      },
    ]);

    await expectRecovery({ recovered: 1, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each([
    {
      label: "non-replay-safe checkpoint",
      checkpoint: {
        status: "waiting",
        runId: "cm_interrupted",
        reason: "pending_tools",
        replaySafe: false,
      },
    },
    {
      label: "replay-safe checkpoint for another run",
      checkpoint: {
        status: "waiting",
        runId: "cm_other",
        reason: "yield",
        replaySafe: true,
      },
    },
  ])("does not resume a Code Mode wait after a $label", async ({ checkpoint }) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("wait", checkpoint),
      codeModeWaitCallMessage(),
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not resume a mixed Code Mode wait and side-effecting tool tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "result.txt", content: "done" },
        },
      ]),
    ]);

    await expectRecovery({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
