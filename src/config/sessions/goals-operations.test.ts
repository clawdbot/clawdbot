import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { lookupSessionGoalOperation, mutateSessionGoal } from "./goals-operations.js";
import type {
  SessionGoalOperation,
  SessionTranscriptTurnMutation,
} from "./goals-operations.types.js";
import { createSessionGoal, clearSessionGoal, updateSessionGoalStatus } from "./goals.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// These tests exercise the durable owner, including rollback and process reopen; existing
// textual Goal tests protect the shared policy but cannot catch a split Goal/turn commit.
describe("typed Goal operation persistence", () => {
  const fixture = useTempSessionsFixture("openclaw-goal-operations-");
  const sessionKey = "agent:main:goal-operations";
  const sessionId = "goal-session-1";
  const now = 1_800_000_000_000;
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const identity = (operationId: string) => ({
    operationId,
    issuedAtMs: now,
    requestFingerprint: operationId,
  });
  const startOperation = (): SessionGoalOperation & { action: "start" } => ({
    ...identity("start-1"),
    action: "start",
    objective: "  clear the backlog 🦞\n/with literal café text\n\t",
  });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const admit = (operation = startOperation(), extra: { shouldAppend?: () => boolean } = {}) =>
    persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      runId: "run-1",
      messages: [
        {
          message: {
            role: "user",
            content: operation.objective,
            idempotencyKey: operation.operationId,
          },
          ...extra,
        },
      ],
      sessionTurnMutation: { kind: "goal", operation, runId: "run-1" },
      sessionLifecyclePatch: { status: "running", lastRunId: "run-1" },
      updateMode: "none",
    });

  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    await upsertSessionEntryCore(scope(), {
      sessionId,
      updatedAt: now,
      status: "done",
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it("commits the literal objective, exact intent identity, lifecycle and receipt together", async () => {
    const turn = await admit();
    const receipt = turn.sessionTurnMutationResult?.result;
    expect(receipt).toMatchObject({
      status: "started",
      runId: "run-1",
      action: "start",
      goal: { objective: startOperation().objective, tokenStart: 100 },
    });
    expect(loadSessionEntry(scope())).toMatchObject({
      status: "running",
      lastRunId: "run-1",
      goal: receipt?.goal,
    });
    expect(turn.messages[0]?.message).toMatchObject({
      content: startOperation().objective,
      __openclaw: {
        intent: {
          kind: "session-goal-start",
          version: 1,
          goalId: receipt?.goalId,
          operationId: "start-1",
        },
      },
    });
    expect(
      lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).toEqual(receipt);
    const editedObjective = "\t resume the café migration 🦞\n/keep every byte ";
    const edited = await mutateSessionGoal({
      ...scope(),
      expectedSessionId: sessionId,
      operation: {
        ...identity("edit-literal"),
        action: "edit",
        goalId: receipt!.goalId,
        objective: editedObjective,
      },
    });
    expect(edited.result.goal?.objective).toBe(editedObjective);
    expect(loadSessionEntry(scope())?.goal?.objective).toBe(editedObjective);
  });

  it("replays the original success after clear and reopening without recreating Goal or turn", async () => {
    const first = await admit();
    await clearSessionGoal(scope());
    const eventsBefore = await loadTranscriptEvents(scope());
    closeOpenClawAgentDatabasesForTest();
    const replay = await admit();
    expect(replay.sessionTurnMutationResult).toEqual({
      result: first.sessionTurnMutationResult?.result,
      replayed: true,
    });
    expect(replay.appendedCount).toBe(0);
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual(eventsBefore);
    await expect(admit({ ...startOperation(), objective: "different" })).rejects.toMatchObject({
      code: "operation-conflict",
    });
    await expect(
      admit({ ...startOperation(), requestFingerprint: "different-attachment" }),
    ).rejects.toMatchObject({ code: "operation-conflict" });
  });

  it.each(["not json", JSON.stringify({ status: "started" })])(
    "rejects a corrupt receipt without reapplying the operation (%s)",
    async (corrupt) => {
      await admit();
      await clearSessionGoal(scope());
      database()
        .db.prepare("UPDATE session_goal_operations SET result_json = ? WHERE operation_id = ?")
        .run(corrupt, "start-1");
      const eventsBefore = await loadTranscriptEvents(scope());
      await expect(admit()).rejects.toThrow("Stored Goal operation receipt is invalid");
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(await loadTranscriptEvents(scope())).toEqual(eventsBefore);
    },
  );

  it("rolls back Goal, lifecycle, and transcript when receipt persistence fails", async () => {
    database().db.exec(
      `CREATE TRIGGER reject_goal_receipt BEFORE INSERT ON session_goal_operations BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;`,
    );
    await expect(admit()).rejects.toThrow("receipt write failed");
    expect(loadSessionEntry(scope())).toMatchObject({ status: "done" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(
      lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).toBeUndefined();
    database().db.exec("DROP TRIGGER reject_goal_receipt");
    await expect(admit()).resolves.toMatchObject({
      appendedCount: 1,
      sessionTurnMutationResult: { replayed: false },
    });
  });

  it("does not commit a Goal when admission skips its message", async () => {
    await expect(admit(startOperation(), { shouldAppend: () => false })).rejects.toThrow(
      "requires a new transcript turn",
    );
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  });

  it("fences stale Goal controls and retains the clear receipt for exact retries", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "first" });
    const clear = { ...identity("clear-1"), action: "clear" as const, goalId: goal.id };
    const cleared = await mutateSessionGoal({
      ...scope(),
      expectedSessionId: sessionId,
      operation: clear,
    });
    const replacement = await createSessionGoal({ ...scope(), objective: "second" });
    expect(
      await mutateSessionGoal({ ...scope(), expectedSessionId: sessionId, operation: clear }),
    ).toMatchObject({ result: cleared.result, replayed: true });
    await expect(
      mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: { ...identity("pause-old"), action: "pause", goalId: goal.id },
      }),
    ).rejects.toMatchObject({ code: "goal-rebound" });
    expect(loadSessionEntry(scope())?.goal?.id).toBe(replacement.id);
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  });

  it("commits Resume with its hidden continuation and the shared fresh budget window", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "finish", tokenBudget: 20 });
    await updateSessionGoalStatus({ ...scope(), status: "paused" });
    await upsertSessionEntryCore(scope(), { ...loadSessionEntry(scope())!, totalTokens: 130 });
    const mutation: SessionTranscriptTurnMutation = {
      kind: "goal",
      operation: { ...identity("resume-1"), action: "resume", goalId: goal.id },
      runId: "run-resume",
    };
    const resumed = await persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      sessionTurnMutation: mutation,
      runId: mutation.runId,
      messages: [
        {
          message: {
            role: "user",
            content: "Continue the current Goal.",
            inputProvenance: { kind: "internal_system" },
            __openclaw: { visibility: { display: false } },
          },
        },
      ],
      sessionLifecyclePatch: { status: "running" },
      updateMode: "none",
    });
    expect(resumed.sessionTurnMutationResult?.result.goal).toMatchObject({
      id: goal.id,
      status: "active",
      tokensUsed: 0,
      tokenStart: 130,
    });
    expect(resumed.messages[0]?.message).toMatchObject({
      inputProvenance: { kind: "internal_system" },
      __openclaw: {
        visibility: { display: false },
        intent: { kind: "session-goal-resume", goalId: goal.id },
      },
    });
  });

  it("rejects receipt replay after the session generation rotates", async () => {
    await admit();
    await replaceSessionEntry(scope(), { sessionId: "goal-session-2", updatedAt: now });
    expect(() =>
      lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).toThrow("Session changed");
    await expect(admit()).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      appendedCount: 0,
    });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("rejects expired operations after pruning and preserves unexpired receipts at capacity", async () => {
    const db = database().db;
    const insert = db.prepare("INSERT INTO session_goal_operations VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 4096; i += 1) {
      insert.run(sessionKey, `retained-${i}`, sessionId, "fingerprint", "{}", now + 60_000);
    }
    await expect(admit()).rejects.toMatchObject({ code: "capacity" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    await admit();
    expect(db.prepare("SELECT count(*) AS count FROM session_goal_operations").get()).toEqual({
      count: 1,
    });
    await clearSessionGoal(scope());
    vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60 * 1000);
    db.prepare("DELETE FROM session_goal_operations").run();
    await expect(admit()).rejects.toMatchObject({ code: "expired" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("rejects turn admission when authority closes during awaited message preparation", async () => {
    let current = true;
    const operation = startOperation();
    await expect(
      persistSessionTranscriptTurn(scope(), {
        expectedSessionId: sessionId,
        sessionTurnMutation: {
          kind: "goal",
          operation,
          runId: "run-1",
          assertCurrent: () => {
            if (!current) {
              throw new Error("authority closed");
            }
          },
        },
        messages: [
          {
            message: { role: "user", content: operation.objective },
            shouldAppend: async () => {
              current = false;
              return true;
            },
          },
        ],
        updateMode: "none",
      }),
    ).rejects.toThrow("authority closed");
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(
      lookupSessionGoalOperation({ ...scope(), expectedSessionId: sessionId, operation }),
    ).toBeUndefined();
  });

  it("revalidates admission authority inside the queued commit before writing", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "finish" });
    await expect(
      mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: { ...identity("pause-1"), action: "pause", goalId: goal.id },
        assertCurrent: () => {
          throw new Error("authority closed");
        },
      }),
    ).rejects.toThrow("authority closed");
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
  });
});
