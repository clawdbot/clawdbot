import { describe, expect, it } from "vitest";
import {
  createSessionGoal,
  getSessionGoal,
  recordSessionGoalContinuation,
  rollbackSessionGoalContinuation,
  updateSessionGoalStatus,
} from "./goals.js";
import { upsertSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionGoalStatus } from "./types.js";

describe("session goal continuation reservations", () => {
  const fixture = useTempSessionsFixture("openclaw-session-goal-continuation-");
  const sessionKey = "agent:main:main";

  async function createGoal() {
    const storePath = fixture.storePath();
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Land deterministic continuation",
      now: 10,
    });
    return { goal, storePath };
  }

  it("atomically reserves a bounded continuation only for the current active goal", async () => {
    const { goal, storePath } = await createGoal();

    const reservations = await Promise.all(
      [20, 30, 40].map((now) =>
        recordSessionGoalContinuation({
          sessionKey,
          storePath,
          goalId: goal.id,
          maxContinuationTurns: 2,
          now,
        }),
      ),
    );
    const staleGoal = await recordSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: "replaced-goal",
      maxContinuationTurns: 3,
      now: 50,
    });

    expect(
      reservations
        .filter((reservation) => reservation !== undefined)
        .map((reservation) => reservation.continuationTurns)
        .sort(),
    ).toEqual([1, 2]);
    expect(reservations.filter((reservation) => reservation === undefined)).toHaveLength(1);
    expect(staleGoal).toBeUndefined();
    expect((await getSessionGoal({ sessionKey, storePath, persist: false })).goal)
      .toMatchObject({ id: goal.id, status: "active", continuationTurns: 2 });
  });

  it("conditionally rolls back only the reservation it still owns", async () => {
    const { goal, storePath } = await createGoal();
    await recordSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: goal.id,
      maxContinuationTurns: 3,
    });

    const stale = await rollbackSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: goal.id,
      expectedContinuationTurns: 2,
    });
    const owned = await rollbackSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: goal.id,
      expectedContinuationTurns: 1,
    });
    const duplicate = await rollbackSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: goal.id,
      expectedContinuationTurns: 1,
    });

    expect(stale).toBe(false);
    expect(owned).toBe(true);
    expect(duplicate).toBe(false);
    expect((await getSessionGoal({ sessionKey, storePath, persist: false })).goal)
      .toMatchObject({ continuationTurns: 0 });
  });

  it.each([
    "paused",
    "blocked",
    "usage_limited",
    "budget_limited",
  ] satisfies SessionGoalStatus[])(
    "starts a fresh continuation window when an operator resumes a %s goal",
    async (status) => {
      const { goal, storePath } = await createGoal();
      await recordSessionGoalContinuation({
        sessionKey,
        storePath,
        goalId: goal.id,
        maxContinuationTurns: 3,
      });
      if (status === "usage_limited" || status === "budget_limited") {
        const snapshot = await getSessionGoal({ sessionKey, storePath, persist: false });
        await upsertSessionEntry(
          { sessionKey, storePath },
          {
            sessionId: "session-1",
            updatedAt: 20,
            totalTokens: 0,
            totalTokensFresh: true,
            goal: { ...snapshot.goal!, status },
          },
        );
      } else {
        await updateSessionGoalStatus({ sessionKey, storePath, status, now: 20 });
      }

      const resumed = await updateSessionGoalStatus({
        sessionKey,
        storePath,
        status: "active",
        now: 30,
      });

      expect(resumed.status).toBe("active");
      expect(resumed.continuationTurns).toBe(0);
    },
  );

  it("does not reset the window on an idempotent active-to-active status write", async () => {
    const { goal, storePath } = await createGoal();
    await recordSessionGoalContinuation({
      sessionKey,
      storePath,
      goalId: goal.id,
      maxContinuationTurns: 3,
    });

    const active = await updateSessionGoalStatus({
      sessionKey,
      storePath,
      status: "active",
      now: 30,
    });

    expect(active.continuationTurns).toBe(1);
  });
});
