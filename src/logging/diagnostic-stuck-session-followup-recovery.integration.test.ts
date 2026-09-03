import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

describe("stuck session follow-up recovery", () => {
  const queueKeys = new Set<string>();

  afterEach(() => {
    clearSessionQueues([...queueKeys]);
    queueKeys.clear();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
  });

  it.each(["followup", "collect"] as const)(
    "continues pending %s work after force-clearing a wedged drain",
    async (mode) => {
      vi.useFakeTimers();
      const sessionKey = `agent:main:wedged-${mode}-drain`;
      const sessionId = `wedged-${mode}-drain-session`;
      const settings: QueueSettings = { mode, debounceMs: 0, cap: 50 };
      const activeEntered = createDeferred();
      const releaseZombie = createDeferred();
      const activeSettled = vi.fn();
      const calls: string[] = [];
      queueKeys.add(sessionKey);

      const runFollowup = async (run: FollowupRun) => {
        calls.push(run.prompt);
        if (calls.length === 1) {
          activeEntered.resolve();
          await releaseZombie.promise;
        }
      };

      try {
        const active = createQueueTestRun({ prompt: "active" });
        active.turnAdoptionLifecycle = {
          onAdopted: async () => {},
          onSettled: activeSettled,
        };
        enqueueFollowupRun(sessionKey, active, settings, "none", runFollowup);
        await activeEntered.promise;
        enqueueFollowupRun(
          sessionKey,
          createQueueTestRun({ prompt: "pending" }),
          settings,
          "none",
          runFollowup,
        );

        const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
        operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
        operation.setPhase("running");
        const recovery = recoverStuckDiagnosticSession({
          sessionId,
          sessionKey,
          ageMs: 720_000,
          queueDepth: 1,
          allowActiveAbort: true,
        });
        await vi.advanceTimersByTimeAsync(15_100);

        await expect(recovery).resolves.toMatchObject({
          status: "aborted",
          action: "abort_embedded_run",
          forceCleared: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain("active");
        expect(calls[1]).toContain("pending");
        expect(activeSettled).toHaveBeenCalledOnce();

        releaseZombie.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(activeSettled).toHaveBeenCalledOnce();
      } finally {
        releaseZombie.resolve();
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("does not retire a fresh source that became active while recovery was settling", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:fresh-followup-owner";
    const sessionId = "fresh-followup-owner-session";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstEntered = createDeferred();
    const secondEntered = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const calls: string[] = [];
    queueKeys.add(sessionKey);

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else if (calls.length === 2) {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
    };

    try {
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "stale" }),
        settings,
        "none",
        runFollowup,
      );
      await firstEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "fresh" }),
        settings,
        "none",
        runFollowup,
      );

      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
      operation.setPhase("running");
      const recovery = recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 720_000,
        queueDepth: 1,
        allowActiveAbort: true,
      });
      releaseFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await secondEntered.promise;
      await vi.advanceTimersByTimeAsync(15_100);

      await expect(recovery).resolves.toMatchObject({ forceCleared: true });
      expect(calls).toEqual(["stale", "fresh"]);
      releaseSecond.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["stale", "fresh"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("continues pending work after releasing an ownerless stale lane task", async () => {
    const sessionKey = "agent:main:ownerless-lane-followup";
    const sessionId = "ownerless-lane-followup-session";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const activeEntered = createDeferred();
    const releaseZombie = createDeferred();
    const laneEntered = createDeferred();
    const releaseLaneTask = createDeferred();
    const calls: string[] = [];
    queueKeys.add(sessionKey);

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        activeEntered.resolve();
        await releaseZombie.promise;
      }
    };
    const laneTask = enqueueCommandInLane(resolveEmbeddedSessionLane(sessionKey), async () => {
      laneEntered.resolve();
      await releaseLaneTask.promise;
    });

    try {
      await laneEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "active" }),
        settings,
        "none",
        runFollowup,
      );
      await activeEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "pending" }),
        settings,
        "none",
        runFollowup,
      );

      await expect(
        recoverStuckDiagnosticSession({
          sessionId,
          sessionKey,
          ageMs: 300_000,
          queueDepth: 1,
        }),
      ).resolves.toMatchObject({
        status: "released",
        action: "release_lane",
        reason: "stale_lane_task",
      });
      await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));

      releaseZombie.resolve();
      await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));
    } finally {
      releaseZombie.resolve();
      releaseLaneTask.resolve();
      await laneTask;
    }
  });
});
