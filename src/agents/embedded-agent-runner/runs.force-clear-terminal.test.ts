import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
  runAfterReplyOperationClear,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDeferredEmbeddedRunLifecycleManager } from "./run/deferred-lifecycle-owner.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isStreaming?: boolean;
  } = {},
): RunHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => overrides.isStreaming ?? true,
    isCompacting: () => false,
    abort: overrides.abort ?? (() => {}),
  };
}

describe("force-clear terminal state persistence", () => {
  let testState: OpenClawTestState | undefined;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-forceclear-",
    });
    storePath = path.join(testState.sessionsDir(), "sessions.json");
    setRuntimeConfigSnapshot({ session: { store: storePath } });
  });

  afterEach(async () => {
    const state = testState;
    testState = undefined;
    try {
      clearRuntimeConfigSnapshot();
      testing.resetActiveEmbeddedRuns();
      replyRunTesting.resetReplyRunRegistry();
    } finally {
      await state?.cleanup();
    }
  });

  it("delays stale-owner followups until the old reply owner settles", async () => {
    // Owner ordering must not depend on the host finishing within the drain deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const sessionKey = "agent:main:reply-stuck-followup";
      const sessionId = "session-reply-stuck-followup";
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      const handle = createRunHandle();
      operation.attachBackend({
        kind: "embedded",
        cancel: handle.abort,
        isStreaming: handle.isStreaming,
      });
      operation.setPhase("running");
      setActiveEmbeddedRun(sessionId, handle, sessionKey);

      const followupObservedActiveHandle: boolean[] = [];
      runAfterReplyOperationClear(operation, () => {
        followupObservedActiveHandle.push(isEmbeddedAgentRunHandleActive(sessionId));
      });

      const recovery = abortAndDrainEmbeddedAgentRun({
        sessionId,
        sessionKey,
        reason: "stuck_recovery",
        forceClear: true,
        settleMs: 100,
      });
      expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);
      expect(followupObservedActiveHandle).toEqual([]);

      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      let recoverySettled = false;
      void recovery.then(() => {
        recoverySettled = true;
      });
      await Promise.resolve();
      expect(recoverySettled).toBe(false);
      expect(followupObservedActiveHandle).toEqual([]);

      operation.complete();
      await expect(recovery).resolves.toEqual({
        aborted: true,
        drained: true,
        forceCleared: false,
      });
      await Promise.resolve();
      expect(followupObservedActiveHandle).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-clears exact owners before releasing followups after cancel throws", async () => {
    const sessionKey = "agent:main:reply-cancel-throws";
    const sessionId = "session-reply-cancel-throws";
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const handle = createRunHandle({
      abort: () => {
        throw new Error("cancel failed");
      },
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    const followupObservedActiveHandle: boolean[] = [];
    runAfterReplyOperationClear(operation, () => {
      followupObservedActiveHandle.push(isEmbeddedAgentRunHandleActive(sessionId));
    });

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 20,
    });

    expect(result).toEqual({ aborted: false, drained: false, forceCleared: true });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    await vi.waitFor(() => {
      expect(followupObservedActiveHandle).toEqual([false]);
    });
  });

  it("force-clears a throwing reply backend without an embedded handle", async () => {
    const sessionKey = "agent:main:reply-only-cancel-throws";
    const sessionId = "session-reply-only-cancel-throws";
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {
        throw new Error("cancel failed");
      },
      isStreaming: () => true,
    });
    operation.setPhase("running");

    const followupObservedActiveOwner: boolean[] = [];
    runAfterReplyOperationClear(operation, () => {
      followupObservedActiveOwner.push(isReplyRunActiveForSessionId(sessionId));
    });

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 20,
    });

    expect(result).toEqual({ aborted: false, drained: false, forceCleared: true });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    await vi.waitFor(() => {
      expect(followupObservedActiveOwner).toEqual([false]);
    });
  });

  it("force-clears a reply-only backend that accepts cancellation without completing", async () => {
    const sessionKey = "agent:main:reply-only-cancel-pending";
    const sessionId = "session-reply-only-cancel-pending";
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const cancel = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    const followupObservedActiveOwner: boolean[] = [];
    runAfterReplyOperationClear(operation, () => {
      followupObservedActiveOwner.push(isReplyRunActiveForSessionId(sessionId));
    });

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 20,
    });

    expect(result).toEqual({ aborted: false, drained: false, forceCleared: true });
    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    await vi.waitFor(() => {
      expect(followupObservedActiveOwner).toEqual([false]);
    });
  });

  it("force-clears active handle and reply owners when cancellation never completes", async () => {
    const sessionKey = "agent:main:handle-cancel-pending";
    const sessionId = "session-handle-cancel-pending";
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const abort = vi.fn();
    const handle = createRunHandle({ abort });
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 20,
    });

    expect(result).toEqual({ aborted: true, drained: false, forceCleared: true });
    expect(abort).toHaveBeenCalled();
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });

  it("persists killed status after a force-cleared run", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "session-1";
    const startedAt = Date.now() - 60_000;

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: startedAt,
        startedAt,
        runtimeMs: 12_345,
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("killed");
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(entry?.runtimeMs).toBe(12_345);
  });

  it("persists a force-cleared bare row under its fixed-store owner", async () => {
    storePath = testState?.statePath("shared-store.sqlite") ?? storePath;
    const sessionKey = "global";
    const sessionId = "session-fixed-owner";
    const startedAt = Date.now() - 60_000;
    setRuntimeConfigSnapshot({
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey, storePath },
      { sessionId, updatedAt: startedAt, startedAt, status: "running" },
    );
    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId,
        sessionKey,
        forceClear: true,
        reason: "stuck_recovery",
        settleMs: 0,
      }),
    ).resolves.toMatchObject({ forceCleared: true });

    expect(loadSessionEntry({ agentId: "ops", sessionKey, storePath })).toMatchObject({
      sessionId,
      status: "killed",
      abortedLastRun: true,
    });
  });

  it("keeps the persisted killed state when the force-cleared owner finishes late", async () => {
    const sessionKey = "agent:main:force-clear-late-completion";
    const sessionId = "session-force-clear-late-completion";
    const startedAt = Date.now() - 60_000;
    const handle = createRunHandle();

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId, updatedAt: startedAt, startedAt, status: "running" },
    );
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId,
        sessionKey,
        forceClear: true,
        reason: "stuck_recovery",
        settleMs: 0,
      }),
    ).resolves.toMatchObject({ forceCleared: true });

    clearActiveEmbeddedRun(sessionId, handle, sessionKey);

    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId,
      status: "killed",
      abortedLastRun: true,
    });
  });

  it.each(
    ["main", "work"].flatMap((agentId) =>
      ["direct", "deferred"].map((registration) => ({ agentId, registration })),
    ),
  )(
    "persists forced terminal state only in $agentId's global store via $registration registration",
    async ({ agentId, registration }) => {
      const sessionKey = "global";
      const sessionId = `${agentId}-global`;
      const startedAt = Date.now() - 60_000;
      setRuntimeConfigSnapshot({
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        session: { scope: "global" },
      });
      for (const owner of ["main", "work"]) {
        await upsertSessionEntryCore(
          { agentId: owner, sessionKey },
          {
            sessionId: `${owner}-global`,
            updatedAt: startedAt,
            startedAt,
            status: "running",
            lifecycleRunId: `${owner}-run`,
          },
        );
      }
      const deferred =
        registration === "deferred"
          ? createDeferredEmbeddedRunLifecycleManager({
              agentId,
              sessionId,
              sessionKey,
              runId: `${agentId}-run`,
            })
          : undefined;
      if (deferred) {
        deferred.handoffToCli();
      } else {
        setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey, undefined, agentId);
      }
      await expect(
        abortAndDrainEmbeddedAgentRun({
          sessionId,
          sessionKey,
          forceClear: true,
          reason: "stuck_recovery",
          settleMs: 0,
        }),
      ).resolves.toMatchObject({ forceCleared: true });
      const entry = loadSessionEntry({ agentId, sessionKey });
      expect(entry).toMatchObject({ sessionId, status: "killed", abortedLastRun: true });
      expect(entry?.endedAt).toBeGreaterThanOrEqual(startedAt);
      expect(entry?.lifecycleRunId).toBeUndefined();
      await deferred?.complete();
      const otherAgentId = agentId === "main" ? "work" : "main";
      expect(loadSessionEntry({ agentId: otherAgentId, sessionKey })).toMatchObject({
        sessionId: `${otherAgentId}-global`,
        status: "running",
        lifecycleRunId: `${otherAgentId}-run`,
      });
    },
  );

  it("does not fail when the session entry is absent", async () => {
    const sessionKey = "agent:main:missing";
    const sessionId = "session-missing";

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);
  });

  it("does not persist state when sessionKey is omitted", async () => {
    const sessionId = "session-no-key";
    const sessionKey = "agent:main:no-key";

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle());

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("running");
  });

  it("does not overwrite a newer session entry under the same key", async () => {
    const sessionKey = "agent:main:shared-key";
    const oldSessionId = "session-old";
    const newSessionId = "session-new";

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: oldSessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    setActiveEmbeddedRun(oldSessionId, createRunHandle(), sessionKey);

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: newSessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: oldSessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.sessionId).toBe(newSessionId);
    expect(entry?.status).toBe("running");
  });

  it("does not clear or kill a replacement run that reuses the session id", async () => {
    const sessionKey = "agent:main:replacement";
    const sessionId = "session-reused";
    const replacement = createRunHandle();

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    const original = createRunHandle({
      abort: () => setActiveEmbeddedRun(sessionId, replacement, sessionKey),
    });
    setActiveEmbeddedRun(sessionId, original, sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result).toEqual({ aborted: true, drained: false, forceCleared: false });
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
  });

  it("does not kill a replacement run that reuses the session key", async () => {
    const sessionKey = "agent:main:replacement-key";
    const oldSessionId = "session-old-owner";
    const newSessionId = "session-new-owner";
    const replacement = createRunHandle();

    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: oldSessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    const original = createRunHandle({
      abort: () => setActiveEmbeddedRun(newSessionId, replacement, sessionKey),
    });
    setActiveEmbeddedRun(oldSessionId, original, sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: oldSessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result).toEqual({ aborted: true, drained: false, forceCleared: true });
    expect(isEmbeddedAgentRunHandleActive(newSessionId)).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
  });
});
