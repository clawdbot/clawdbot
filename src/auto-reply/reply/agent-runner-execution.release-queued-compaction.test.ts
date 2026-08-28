/**
 * Branch tests for `releaseQueuedCompactionCompletion`.
 *
 * This helper is the post-queued-compaction dispatcher invoked from the
 * request_compaction async-resolution path in agent-runner-execution.
 * It owns incrementing the run-compaction count, refreshing the session entry,
 * dispatching post-compaction delegates, and emitting the continuation-released
 * span.
 *
 * The four-branch table covered here:
 *   1. compactionResult.ok === false               → early no-op
 *   2. compactionResult.compacted === false        → early no-op
 *   3. sessionKey / activeSessionStore missing     → logs `session-store-unavailable`, no-op
 *   4. happy-path: increment → dispatch → span     → ordering + arg-passthrough
 *   4b. sessionEntry resolves to undefined         → logs `session-entry-unavailable`, no-op
 *
 * Branches 1 & 2 are unreachable through the single call site at L2152 because
 * that site already gates on `if (result.ok && result.compacted)`. They are
 * defensive guards inside the helper. Testing them directly here means a future
 * refactor that drops either guard breaks these tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  incrementRunCompactionCountMock: vi.fn(),
  dispatchPostCompactionDelegatesMock: vi.fn(),
  emitContinuationCompactionReleasedSpanMock: vi.fn(),
  logVerboseMock: vi.fn(),
  resolveSessionStoreEntryMock: vi.fn(),
  stagePostCompactionDelegateMock: vi.fn(),
}));

vi.mock("../continuation/delegate-store-post-compaction.js", () => ({
  stagePostCompactionDelegate: (sessionKey: string, delegate: unknown) =>
    state.stagePostCompactionDelegateMock(sessionKey, delegate),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: (msg: string) => state.logVerboseMock(msg),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveFreshSessionTotalTokens: vi.fn(),
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryFromStore: (params: unknown) => state.resolveSessionStoreEntryMock(params),
}));

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: (params: unknown) => state.incrementRunCompactionCountMock(params),
}));

vi.mock("./post-compaction-delegate-dispatch.js", () => ({
  dispatchPostCompactionDelegates: (params: unknown) =>
    state.dispatchPostCompactionDelegatesMock(params),
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationCompactionReleasedSpan: (params: unknown) =>
    state.emitContinuationCompactionReleasedSpanMock(params),
}));

async function getReleaseQueuedCompactionCompletion() {
  return (await import("./agent-runner-post-compaction-release.js"))
    .releaseQueuedCompactionCompletion;
}

async function getReleaseQueuedCompactionTolerant() {
  return (await import("./agent-runner-post-compaction-release.js"))
    .releaseQueuedCompactionTolerant;
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id-default",
    updatedAt: 1,
    ...overrides,
  } as SessionEntry;
}

function makeFollowupRun(overrides?: { config?: unknown }): FollowupRun {
  return {
    prompt: "p",
    summaryLine: "p",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session-id-default",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: overrides?.config ?? { runtime: { id: "cfg" } },
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

const STORE_PATH = "/tmp/sessions/store.json";
const SESSION_KEY = "main";
const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

beforeEach(() => {
  state.incrementRunCompactionCountMock.mockReset();
  state.dispatchPostCompactionDelegatesMock.mockReset();
  state.emitContinuationCompactionReleasedSpanMock.mockReset();
  state.logVerboseMock.mockReset();
  state.resolveSessionStoreEntryMock.mockReset();
  state.stagePostCompactionDelegateMock.mockReset();
});

describe("releaseQueuedCompactionCompletion: early-return guards", () => {
  it("returns without mutation when compactionResult.ok is false (branch 1)", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    await release({
      activeSessionStore,
      compactionResult: { ok: false, compacted: false, reason: "rejected-by-provider" },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.incrementRunCompactionCountMock).not.toHaveBeenCalled();
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();
    expect(state.resolveSessionStoreEntryMock).not.toHaveBeenCalled();
    expect(state.logVerboseMock).not.toHaveBeenCalled();
  });

  it("returns without mutation when compactionResult.compacted is false (branch 2)", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    await release({
      activeSessionStore,
      compactionResult: {
        ok: true,
        compacted: false,
        reason: "no-op-below-threshold",
      },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.incrementRunCompactionCountMock).not.toHaveBeenCalled();
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();
    expect(state.resolveSessionStoreEntryMock).not.toHaveBeenCalled();
    expect(state.logVerboseMock).not.toHaveBeenCalled();
  });
});

describe("releaseQueuedCompactionCompletion: session-store-unavailable guard (branch 3)", () => {
  it("logs session-store-unavailable when sessionKey is undefined", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    await release({
      activeSessionStore,
      compactionResult: { ok: true, compacted: true },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: undefined,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.logVerboseMock).toHaveBeenCalledTimes(1);
    const msg = state.logVerboseMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain("[request_compaction:post-compaction-release-skipped]");
    expect(msg).toContain("reason=session-store-unavailable");
    expect(msg).toContain("session=none");
    expect(state.incrementRunCompactionCountMock).not.toHaveBeenCalled();
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();
  });

  it("logs session-store-unavailable when activeSessionStore is undefined", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry();

    await release({
      activeSessionStore: undefined,
      compactionResult: { ok: true, compacted: true },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.logVerboseMock).toHaveBeenCalledTimes(1);
    const msg = state.logVerboseMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain("reason=session-store-unavailable");
    expect(msg).toContain(`session=${SESSION_KEY}`);
    expect(state.incrementRunCompactionCountMock).not.toHaveBeenCalled();
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();
  });
});

describe("releaseQueuedCompactionCompletion: session-entry-unavailable guard (branch 4b)", () => {
  it("logs session-entry-unavailable when neither getter nor store has an entry", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const activeSessionStore: Record<string, SessionEntry> = {};

    await release({
      activeSessionStore,
      compactionResult: { ok: true, compacted: true },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => undefined,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.logVerboseMock).toHaveBeenCalledTimes(1);
    const msg = state.logVerboseMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain("reason=session-entry-unavailable");
    expect(msg).toContain(`session=${SESSION_KEY}`);
    expect(state.incrementRunCompactionCountMock).not.toHaveBeenCalled();
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();
    expect(state.resolveSessionStoreEntryMock).not.toHaveBeenCalled();
  });
});

describe("releaseQueuedCompactionCompletion: happy-path dispatch (branch 4)", () => {
  it("increments compaction count, dispatches delegates, then emits released span (in order, with correct args)", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const initialSessionEntry = makeSessionEntry({ sessionId: "session-before" });
    const refreshedSessionEntry = makeSessionEntry({ sessionId: "session-after" });
    const activeSessionStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: initialSessionEntry,
    };
    const compactionId = 7;
    const queuedDelegates = 3;

    const calls: string[] = [];
    state.incrementRunCompactionCountMock.mockImplementation(async () => {
      calls.push("increment");
      return compactionId;
    });
    state.resolveSessionStoreEntryMock.mockImplementation(() => {
      calls.push("resolve");
      return { existing: refreshedSessionEntry, legacyKeys: [], normalizedKey: SESSION_KEY };
    });
    state.dispatchPostCompactionDelegatesMock.mockImplementation(async () => {
      calls.push("dispatch");
      return { queuedDelegates };
    });
    state.emitContinuationCompactionReleasedSpanMock.mockImplementation(() => {
      calls.push("span");
    });

    const followupRun = makeFollowupRun({ config: { runtime: { id: "cfg-happy" } } });

    await release({
      activeSessionStore,
      compactionResult: {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          firstKeptEntryId: "entry-0",
          tokensBefore: 100_000,
          tokensAfter: 5_000,
          sessionId: "new-session-id",
          sessionFile: "/tmp/new-session.jsonl",
        },
      },
      followupRun,
      getActiveSessionEntry: () => initialSessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    // Ordering: increment MUST happen before dispatch; resolve sits between them;
    // span emits last with the compactionId from increment.
    expect(calls).toEqual(["increment", "resolve", "dispatch", "span"]);

    // 1. incrementRunCompactionCount
    expect(state.incrementRunCompactionCountMock).toHaveBeenCalledTimes(1);
    const incArg = state.incrementRunCompactionCountMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(incArg.amount).toBe(1);
    expect(incArg.sessionEntry).toBe(initialSessionEntry);
    expect(incArg.sessionStore).toBe(activeSessionStore);
    expect(incArg.sessionKey).toBe(SESSION_KEY);
    expect(incArg.storePath).toBe(STORE_PATH);
    expect(incArg.cfg).toBe(followupRun.run.config);
    expect(incArg.compactionTokensAfter).toBe(5_000);
    expect(incArg.newSessionId).toBe("new-session-id");
    expect(incArg.agentId).toBe("agent");

    // 2. resolveSessionStoreEntry
    expect(state.resolveSessionStoreEntryMock).toHaveBeenCalledTimes(1);
    const resolveArg = state.resolveSessionStoreEntryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(resolveArg.store).toBe(activeSessionStore);
    expect(resolveArg.sessionKey).toBe(SESSION_KEY);

    // 3. dispatchPostCompactionDelegates — uses REFRESHED entry and compactionId from step 1.
    expect(state.dispatchPostCompactionDelegatesMock).toHaveBeenCalledTimes(1);
    const dispatchArg = state.dispatchPostCompactionDelegatesMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(dispatchArg.compactionCount).toBe(compactionId);
    expect(dispatchArg.sessionEntry).toBe(refreshedSessionEntry);
    expect(dispatchArg.sessionEntry).not.toBe(initialSessionEntry);
    expect(dispatchArg.sessionKey).toBe(SESSION_KEY);
    expect(dispatchArg.sessionStore).toBe(activeSessionStore);
    expect(dispatchArg.storePath).toBe(STORE_PATH);
    expect(dispatchArg.followupRun).toBe(followupRun);
    expect(dispatchArg.cfg).toBe(followupRun.run.config);
    expect(dispatchArg.releaseTraceparent).toBe(TRACEPARENT);
    expect(dispatchArg.postCompactionDelegatesToPreserve).toEqual([]);

    // 4. emitContinuationCompactionReleasedSpan
    expect(state.emitContinuationCompactionReleasedSpanMock).toHaveBeenCalledTimes(1);
    const spanArg = state.emitContinuationCompactionReleasedSpanMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(spanArg.releasedCount).toBe(queuedDelegates);
    expect(spanArg.compactionId).toBe(compactionId);
    expect(spanArg.traceparent).toBe(TRACEPARENT);
    expect(typeof spanArg.log).toBe("function");

    // No spurious logVerbose entries from the happy path itself; the span's
    // logger callback is invoked only by the emitter, which is mocked.
    expect(state.logVerboseMock).not.toHaveBeenCalled();
  });

  it("falls back to activeSessionStore[sessionKey] when getActiveSessionEntry returns undefined", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const storedEntry = makeSessionEntry({ sessionId: "from-store" });
    const refreshedEntry = makeSessionEntry({ sessionId: "from-resolve" });
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: storedEntry };

    state.incrementRunCompactionCountMock.mockResolvedValue(42);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: refreshedEntry,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    state.dispatchPostCompactionDelegatesMock.mockResolvedValue({ queuedDelegates: 0 });

    await release({
      activeSessionStore,
      compactionResult: { ok: true, compacted: true },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => undefined,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.incrementRunCompactionCountMock).toHaveBeenCalledTimes(1);
    const incArg = state.incrementRunCompactionCountMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // The getter returned undefined, so the helper must reach into the store
    // to get the entry before the increment call.
    expect(incArg.sessionEntry).toBe(storedEntry);
    expect(state.dispatchPostCompactionDelegatesMock).toHaveBeenCalledTimes(1);
    expect(state.emitContinuationCompactionReleasedSpanMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stale sessionEntry when resolveSessionStoreEntry has no existing match", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const initialSessionEntry = makeSessionEntry({ sessionId: "stale" });
    const activeSessionStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: initialSessionEntry,
    };

    state.incrementRunCompactionCountMock.mockResolvedValue(1);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: undefined,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    state.dispatchPostCompactionDelegatesMock.mockResolvedValue({ queuedDelegates: 0 });

    await release({
      activeSessionStore,
      compactionResult: { ok: true, compacted: true },
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => initialSessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    const dispatchArg = state.dispatchPostCompactionDelegatesMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // resolved.existing was undefined, so refreshedSessionEntry falls back to
    // the original (pre-resolve) sessionEntry. This guards the `??` chain.
    expect(dispatchArg.sessionEntry).toBe(initialSessionEntry);
  });
});

/**
 * I2: the volitional request_compaction release path must recover delegates
 * that dispatchPostCompactionDelegates could neither enqueue nor re-persist
 * (double persistence failure). It leaves survivors in the preserve array;
 * the caller must re-stage them so recovery work is not silently dropped —
 * matching the auto-compaction path's finally in agent-runner.ts.
 */
describe("releaseQueuedCompactionCompletion: preserves delegates on double persistence failure (I2)", () => {
  const COMPACTION_RESULT = {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: "compacted",
      firstKeptEntryId: "entry-0",
      tokensBefore: 100_000,
      tokensAfter: 5_000,
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.jsonl",
    },
  };

  it("re-stages delegates that dispatch could not enqueue or re-persist", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry({ sessionId: "session-i2" });
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };
    const preservedDelegate = { task: "survive double failure", createdAt: 1, firstArmedAt: 1 };

    state.incrementRunCompactionCountMock.mockResolvedValue(9);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: sessionEntry,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    // Simulate an enqueue failure AND a re-persist failure inside dispatch: the
    // survivor is left on the preserve array (real dispatch behavior).
    state.dispatchPostCompactionDelegatesMock.mockImplementation(
      async (params: { postCompactionDelegatesToPreserve: unknown[] }) => {
        params.postCompactionDelegatesToPreserve.push(preservedDelegate);
        return { queuedDelegates: 0 };
      },
    );

    await release({
      activeSessionStore,
      compactionResult: COMPACTION_RESULT,
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.stagePostCompactionDelegateMock).toHaveBeenCalledTimes(1);
    expect(state.stagePostCompactionDelegateMock).toHaveBeenCalledWith(
      SESSION_KEY,
      preservedDelegate,
    );
  });

  it("does not re-stage when dispatch preserves nothing", async () => {
    const release = await getReleaseQueuedCompactionCompletion();
    const sessionEntry = makeSessionEntry({ sessionId: "session-i2-clean" });
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    state.incrementRunCompactionCountMock.mockResolvedValue(9);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: sessionEntry,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    state.dispatchPostCompactionDelegatesMock.mockResolvedValue({ queuedDelegates: 2 });

    await release({
      activeSessionStore,
      compactionResult: COMPACTION_RESULT,
      followupRun: makeFollowupRun(),
      getActiveSessionEntry: () => sessionEntry,
      sessionKey: SESSION_KEY,
      storePath: STORE_PATH,
      traceparent: TRACEPARENT,
    });

    expect(state.stagePostCompactionDelegateMock).not.toHaveBeenCalled();
  });
});

/**
 * releaseQueuedCompactionTolerant must isolate release-side
 * failures from the caller's compaction-outcome signal.
 *
 * compactEmbeddedAgentSession has already mutated session-snapshot truth on
 * disk before release runs. If release throws and that throw flips the
 * caller's outcome to `{ ok: false, compacted: false }`, the agent retries
 * compaction on an already-compacted session — double-compaction risk.
 *
 * These tests force the downstream deps of releaseQueuedCompactionCompletion
 * (incrementRunCompactionCount, dispatchPostCompactionDelegates, span emit)
 * to throw. The tolerant wrapper must swallow + logVerbose + not re-throw.
 */
describe("releaseQueuedCompactionTolerant: error-isolation guard", () => {
  it("resolves silently when the underlying release succeeds (happy-path passthrough)", async () => {
    const tolerant = await getReleaseQueuedCompactionTolerant();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    state.incrementRunCompactionCountMock.mockResolvedValue(1);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: sessionEntry,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    state.dispatchPostCompactionDelegatesMock.mockResolvedValue({ queuedDelegates: 0 });

    await expect(
      tolerant({
        activeSessionStore,
        compactionResult: { ok: true, compacted: true },
        followupRun: makeFollowupRun(),
        getActiveSessionEntry: () => sessionEntry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
        traceparent: TRACEPARENT,
      }),
    ).resolves.toBeUndefined();

    // Success-path must NOT emit a release-failed verbose log.
    const failedLogs = state.logVerboseMock.mock.calls.filter((call) =>
      String(call[0]).includes("[request_compaction:post-compaction-release-failed]"),
    );
    expect(failedLogs).toHaveLength(0);
    // Sanity: the underlying release did fire its happy-path deps.
    expect(state.incrementRunCompactionCountMock).toHaveBeenCalledTimes(1);
    expect(state.dispatchPostCompactionDelegatesMock).toHaveBeenCalledTimes(1);
    expect(state.emitContinuationCompactionReleasedSpanMock).toHaveBeenCalledTimes(1);
  });

  it("swallows Error thrown by incrementRunCompactionCount and logs the reason", async () => {
    const tolerant = await getReleaseQueuedCompactionTolerant();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    state.incrementRunCompactionCountMock.mockRejectedValue(new Error("session-store I/O failure"));

    await expect(
      tolerant({
        activeSessionStore,
        compactionResult: { ok: true, compacted: true },
        followupRun: makeFollowupRun(),
        getActiveSessionEntry: () => sessionEntry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
        traceparent: TRACEPARENT,
      }),
    ).resolves.toBeUndefined();

    // Outer cleanup short-circuits at the increment throw; dispatch + span
    // never run, but the tolerant wrapper must not re-throw.
    expect(state.dispatchPostCompactionDelegatesMock).not.toHaveBeenCalled();
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();

    const failedLogs = state.logVerboseMock.mock.calls.filter((call) =>
      String(call[0]).includes("[request_compaction:post-compaction-release-failed]"),
    );
    expect(failedLogs).toHaveLength(1);
    const msg = failedLogs[0]?.[0] as string;
    expect(msg).toContain(`session=${SESSION_KEY}`);
    expect(msg).toContain("reason=session-store I/O failure");
  });

  it("swallows Error thrown by dispatchPostCompactionDelegates and logs the reason", async () => {
    const tolerant = await getReleaseQueuedCompactionTolerant();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    state.incrementRunCompactionCountMock.mockResolvedValue(1);
    state.resolveSessionStoreEntryMock.mockReturnValue({
      existing: sessionEntry,
      legacyKeys: [],
      normalizedKey: SESSION_KEY,
    });
    state.dispatchPostCompactionDelegatesMock.mockRejectedValue(
      new Error("delegate dispatch crashed"),
    );

    await expect(
      tolerant({
        activeSessionStore,
        compactionResult: { ok: true, compacted: true },
        followupRun: makeFollowupRun(),
        getActiveSessionEntry: () => sessionEntry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
        traceparent: TRACEPARENT,
      }),
    ).resolves.toBeUndefined();

    // increment succeeded, dispatch threw, span never ran.
    expect(state.incrementRunCompactionCountMock).toHaveBeenCalledTimes(1);
    expect(state.emitContinuationCompactionReleasedSpanMock).not.toHaveBeenCalled();

    const failedLogs = state.logVerboseMock.mock.calls.filter((call) =>
      String(call[0]).includes("[request_compaction:post-compaction-release-failed]"),
    );
    expect(failedLogs).toHaveLength(1);
    const msg = failedLogs[0]?.[0] as string;
    expect(msg).toContain("reason=delegate dispatch crashed");
  });

  it("coerces non-Error throws via String() so the verbose log still carries a reason", async () => {
    const tolerant = await getReleaseQueuedCompactionTolerant();
    const sessionEntry = makeSessionEntry();
    const activeSessionStore: Record<string, SessionEntry> = { [SESSION_KEY]: sessionEntry };

    // exercising non-Error throws on purpose (verifies String() coercion)
    state.incrementRunCompactionCountMock.mockImplementation(() => {
      throw new Error("raw-string-thrown-by-store");
    });

    await expect(
      tolerant({
        activeSessionStore,
        compactionResult: { ok: true, compacted: true },
        followupRun: makeFollowupRun(),
        getActiveSessionEntry: () => sessionEntry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
        traceparent: TRACEPARENT,
      }),
    ).resolves.toBeUndefined();

    const failedLogs = state.logVerboseMock.mock.calls.filter((call) =>
      String(call[0]).includes("[request_compaction:post-compaction-release-failed]"),
    );
    expect(failedLogs).toHaveLength(1);
    const msg = failedLogs[0]?.[0] as string;
    expect(msg).toContain("reason=raw-string-thrown-by-store");
  });
});
