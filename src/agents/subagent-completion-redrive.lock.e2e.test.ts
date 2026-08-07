/**
 * Compaction-unlock redrive over the real SQLite session write-lock.
 *
 * Proves the full causal chain on production code paths (no harness mocks for
 * the lock, the registry, or the retry):
 *   1. Lock contention — a compaction-style hold on the requester session
 *      write-lock makes a second acquire on the same key time out with
 *      "session file locked", the exact failure that suspends a completed
 *      subagent's announce.
 *   2. The completed subagent's delivery is suspended with reason "expiry"
 *      inside the held window (real settle into SQLite).
 *   3. The lock is released.
 *   4. redriveSuspendedSubagentCompletionsForRequester matches the held window,
 *      resolves the run id to the owning TaskRecord.taskId, and retries
 *      delivery (real SQLite write).
 *   5. The delivery returns to `pending`, generation bumps, and the requester
 *      resumption path is re-armed so the parent session receives the result.
 *
 * `resumeSubagentRun` is mocked exactly as in
 * subagent-completion-admission.store.test.ts; its own announce-delivery
 * behavior is covered by the lifecycle suite. Everything else is real.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  ensureTaskRegistryReady,
  findTaskByRunId,
  getTaskById,
} from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../test-utils/env.js";
import { SessionWriteLockTimeoutError } from "./session-write-lock-error.js";
import { acquireSessionWriteLock, resolveSessionWriteLockTargetKey } from "./session-write-lock.js";
import { resetSessionWriteLockStateForTest } from "./session-write-lock.test-support.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import { redriveSuspendedSubagentCompletionsForRequester } from "./subagent-completion-redrive.runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun }));

const REQUESTER = "agent:main:main";
const CHILD_SESSION = "agent:main:subagent:child";

describe("compaction-unlock redrive over the real SQLite session write-lock", () => {
  let tempDir: string;
  let lockKey: string;

  beforeEach(() => {
    resumeSubagentRun.mockReset();
    tempDir = tempDirs.make("openclaw-redrive-lock-", resolvePreferredOpenClawTmpDir());
    // A real session-write-lock target whose store lives inside the isolated
    // temp dir, so the SQLite lease never touches the operator's state.
    const storePath = path.join(tempDir, "sessions", "main", "session-1.sqlite");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "");
    lockKey = resolveSessionWriteLockTargetKey({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: REQUESTER,
      storePath,
    });
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    resetSessionWriteLockStateForTest();
  });

  it("recovers an expiry-suspended completion once the held lock is released", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      // 1. Lock contention: the first hold owns the lease; a second acquire on
      //    the same key times out with the exact "session file locked" error a
      //    competing announce would hit.
      const firstHold = await acquireSessionWriteLock({
        sessionFile: lockKey,
        targetKind: "session-key",
        timeoutMs: 500,
        maxHoldMs: 10_000,
      });
      const heldFrom = Date.now();
      await expect(
        acquireSessionWriteLock({
          sessionFile: lockKey,
          targetKind: "session-key",
          timeoutMs: 80,
        }),
      ).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);

      // 2. A completed subagent's announce gave up while the lock was held:
      //    delivery suspended with reason "expiry" inside the held window.
      const now = Date.now();
      const task: TaskRecord = {
        taskId: "task-completion",
        runtime: "subagent",
        requesterSessionKey: REQUESTER,
        ownerKey: REQUESTER,
        scopeKind: "session",
        childSessionKey: CHILD_SESSION,
        runId: "task-run",
        task: "finish the work",
        status: "succeeded",
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        createdAt: now - 2_000,
        endedAt: now - 1_000,
        lastEventAt: now,
        error: "session file locked",
        terminalSummary: "Task completed, but result delivery is blocked.",
        cleanupAfter: now + 7 * 24 * 60 * 60_000,
      };
      const entry = createSubagentRunRecord({
        runId: "completion-run",
        taskRunId: task.runId,
        childSessionKey: task.childSessionKey,
        requesterSessionKey: task.requesterSessionKey,
        requesterDisplayKey: task.requesterSessionKey,
        task: task.task,
        createdAt: task.createdAt,
        endedAt: task.endedAt,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: {
          required: true,
          resultText: "canonical result",
          capturedAt: now,
        },
        delivery: {
          status: "suspended",
          disposition: "permanent_failure",
          generation: 1,
          windowStartedAt: now - 60_000,
          deadlineAt: now,
          suspendedAt: now,
          suspendedReason: "expiry",
          attemptCount: 3,
          lastError: "session file locked",
          payload: {
            requesterSessionKey: task.requesterSessionKey,
            requesterDisplayKey: task.requesterSessionKey,
            childSessionKey: task.childSessionKey,
            childRunId: task.runId,
            task: task.task,
            endedAt: task.endedAt,
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
          },
        },
      });
      settleSubagentCompletionDelivery({ subagent: entry, task });
      subagentRuns.set(entry.runId, entry);
      ensureTaskRegistryReady();
      expect(findTaskByRunId(task.runId!)?.taskId).toBe(task.taskId);

      // 3. Compaction releases the lock.
      await firstHold.release();
      const releasedAt = Date.now();

      // 4. Real redrive: window match + run->task resolution + real retry.
      const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER, {
        heldFrom,
        releasedAt,
      });
      expect(result).toEqual({ matched: 1, redriven: 1 });

      // 5. Recovery: delivery back to pending with a bumped generation, the
      //    task projected back to a recoverable state, and the requester
      //    resumption path re-armed for the parent-session receipt.
      expect(subagentRuns.get(entry.runId)?.delivery).toMatchObject({
        status: "pending",
        disposition: "retryable",
        generation: 2,
        attemptCount: 0,
        suspendedAt: undefined,
        suspendedReason: undefined,
      });
      expect(resumeSubagentRun).toHaveBeenCalledWith(entry.runId);
      expect(getTaskById(task.taskId)).toMatchObject({
        deliveryStatus: "pending",
        terminalOutcome: "succeeded",
        progressSummary: "canonical result",
      });
      expect(getTaskById(task.taskId)?.error).toBeUndefined();
    });
  });

  it("leaves suspensions outside the held window untouched", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const heldFrom = Date.now();
      const now = heldFrom;
      const task: TaskRecord = {
        taskId: "task-completion-stale",
        runtime: "subagent",
        requesterSessionKey: REQUESTER,
        ownerKey: REQUESTER,
        scopeKind: "session",
        childSessionKey: CHILD_SESSION,
        runId: "task-run-stale",
        task: "finish the work",
        status: "succeeded",
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        createdAt: now - 2_000,
        endedAt: now - 1_000,
        lastEventAt: now,
        error: "session file locked",
        terminalSummary: "Task completed, but result delivery is blocked.",
        cleanupAfter: now + 7 * 24 * 60 * 60_000,
      };
      const entry = createSubagentRunRecord({
        runId: "completion-run-stale",
        taskRunId: task.runId,
        childSessionKey: task.childSessionKey,
        requesterSessionKey: task.requesterSessionKey,
        requesterDisplayKey: task.requesterSessionKey,
        task: task.task,
        createdAt: task.createdAt,
        endedAt: task.endedAt,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: {
          required: true,
          resultText: "stale result",
          capturedAt: now,
        },
        delivery: {
          status: "suspended",
          disposition: "permanent_failure",
          generation: 1,
          windowStartedAt: now - 60_000,
          deadlineAt: now,
          // Suspended well before this compaction's hold window began.
          suspendedAt: now - 20_000,
          suspendedReason: "expiry",
          attemptCount: 3,
          lastError: "session file locked",
          payload: {
            requesterSessionKey: task.requesterSessionKey,
            requesterDisplayKey: task.requesterSessionKey,
            childSessionKey: task.childSessionKey,
            childRunId: task.runId,
            task: task.task,
            endedAt: task.endedAt,
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
          },
        },
      });
      settleSubagentCompletionDelivery({ subagent: entry, task });
      subagentRuns.set(entry.runId, entry);
      ensureTaskRegistryReady();

      const releasedAt = now;
      const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER, {
        heldFrom,
        releasedAt,
      });

      expect(result).toEqual({ matched: 0, redriven: 0 });
      expect(resumeSubagentRun).not.toHaveBeenCalled();
      expect(subagentRuns.get(entry.runId)?.delivery).toMatchObject({
        status: "suspended",
        suspendedReason: "expiry",
      });
    });
  });
});
