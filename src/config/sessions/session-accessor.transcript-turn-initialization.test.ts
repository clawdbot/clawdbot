import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { lookupSessionGoalOperation } from "./goals-operations.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  type SessionTranscriptTurnPersistOptions,
} from "./session-accessor.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("first transcript turn initialization", () => {
  const fixture = useTempSessionsFixture("openclaw-first-goal-turn-");
  const now = 1_800_000_000_000;
  const sessionId = "first-goal-session";
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId,
    storePath: fixture.storePath(),
  });
  const operation = {
    action: "start" as const,
    operationId: "first-goal-operation",
    issuedAtMs: now,
    requestFingerprint: "first-goal-fingerprint",
    objective: "  /stop\nkeep the objective literal\n",
  };
  const initialSessionEntry: SessionEntry = {
    sessionId,
    updatedAt: now,
    sessionStartedAt: now,
    lifecycleRevision: "first-lifecycle",
    createdAt: now,
    createdVia: "operator",
    createdActor: { type: "human", id: "operator-profile" },
    sandbox: "required",
  };
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const counts = () =>
    database()
      .db.prepare(
        `SELECT
          (SELECT count(*) FROM session_nodes) AS nodes,
          (SELECT count(*) FROM session_windows) AS windows,
          (SELECT count(*) FROM transcript_events) AS events,
          (SELECT count(*) FROM session_goal_operations) AS receipts`,
      )
      .get();
  const admit = (options: Partial<SessionTranscriptTurnPersistOptions> = {}) =>
    persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      initialSessionEntry,
      messages: [
        {
          message: {
            role: "user",
            content: operation.objective,
            idempotencyKey: `${operation.operationId}:user`,
          },
        },
      ],
      sessionTurnMutation: { kind: "goal", operation, runId: operation.operationId },
      sessionLifecyclePatch: {
        status: "running",
        lifecycleRunId: operation.operationId,
        restartRecoveryDeliveryRunId: operation.operationId,
        restartRecoveryDeliverySourceRunId: operation.operationId,
        restartRecoveryDeliveryRequestFingerprint: operation.requestFingerprint,
      },
      updateMode: "none",
      ...options,
    });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it("creates the first session, Goal, input and run receipt atomically and replays after reopen", async () => {
    expect(loadSessionEntry(scope())).toBeUndefined();
    const turn = await admit();
    expect(turn).toMatchObject({
      appendedCount: 1,
      sessionEntry: {
        ...initialSessionEntry,
        status: "running",
        restartRecoveryDeliveryRunId: operation.operationId,
        goal: { objective: operation.objective, status: "active" },
      },
      sessionTurnMutationResult: {
        replayed: false,
        result: { action: "start", status: "started", sessionId, runId: operation.operationId },
      },
    });
    expect(turn.messages[0]?.message).toMatchObject({ content: operation.objective });
    expect(counts()).toEqual({ nodes: 1, windows: 1, events: 2, receipts: 1 });
    expect(
      lookupSessionGoalOperation({ ...scope(), expectedSessionId: sessionId, operation }),
    ).toEqual(turn.sessionTurnMutationResult?.result);

    closeOpenClawAgentDatabasesForTest();
    const replay = await admit();
    expect(replay).toMatchObject({
      appendedCount: 0,
      sessionTurnMutationResult: { replayed: true, result: turn.sessionTurnMutationResult?.result },
    });
    expect(counts()).toEqual({ nodes: 1, windows: 1, events: 2, receipts: 1 });
  });

  it.each([
    { timing: "before preparation", competingSessionId: "competing-session" },
    { timing: "during preparation", competingSessionId: "competing-session" },
    { timing: "during preparation", competingSessionId: sessionId },
  ])(
    "does not replace $competingSessionId created $timing",
    async ({ timing, competingSessionId }) => {
      const competing = { sessionId: competingSessionId, updatedAt: now };
      if (timing === "before preparation") {
        await replaceSessionEntry(scope(), competing);
      }
      const turn = await admit({
        messages: [
          {
            message: { role: "user", content: operation.objective },
            shouldAppend: async () => {
              if (timing === "during preparation") {
                await replaceSessionEntry(scope(), competing);
              }
              return true;
            },
          },
        ],
      });
      expect(turn).toMatchObject({ rejectedReason: "session-rebound", appendedCount: 0 });
      expect(loadSessionEntry(scope())).toMatchObject(competing);
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      expect(counts()).toEqual({ nodes: 1, windows: 1, events: 0, receipts: 0 });
    },
  );

  it("rolls back even the session placeholder and header when the receipt cannot commit", async () => {
    database().db.exec(
      `CREATE TRIGGER reject_first_goal_receipt BEFORE INSERT ON session_goal_operations
        BEGIN SELECT RAISE(ABORT, 'first receipt failed'); END;`,
    );
    await expect(admit()).rejects.toThrow("first receipt failed");
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(counts()).toEqual({ nodes: 0, windows: 0, events: 0, receipts: 0 });
    database().db.exec("DROP TRIGGER reject_first_goal_receipt");
    await expect(admit()).resolves.toMatchObject({ appendedCount: 1 });
  });

  it("does not recreate a deleted session from its retained Goal receipt", async () => {
    await admit();
    await applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: fixture.storePath(),
      removals: [{ sessionKey: scope().sessionKey }],
      skipMaintenance: true,
    });
    expect(loadSessionEntry(scope())).toBeUndefined();
    const before = counts();
    expect(before).toMatchObject({ receipts: 1 });
    await expect(admit()).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      appendedCount: 0,
    });
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it("keeps first-session creation absent when admission authority closes during preparation", async () => {
    let current = true;
    await expect(
      admit({
        sessionTurnMutation: {
          kind: "goal",
          operation,
          runId: operation.operationId,
          assertCurrent: () => {
            if (!current) {
              throw new Error("admission closed");
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
      }),
    ).rejects.toThrow("admission closed");
    expect(counts()).toEqual({ nodes: 0, windows: 0, events: 0, receipts: 0 });
  });
});
