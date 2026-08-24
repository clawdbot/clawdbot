import { describe, expect, it, vi } from "vitest";
import {
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";
const REQUESTER_TURN = "run-requester";

function makeRun(runId: string, requesterTurnYielded = true): SubagentRunRecord {
  return {
    runId,
    requesterTurnRunId: REQUESTER_TURN,
    ...(requesterTurnYielded ? { requesterTurnYielded: true } : {}),
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 2_000 },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
  };
}

function accepted(entry: SubagentRunRecord) {
  return { runId: entry.runId, childSessionKey: entry.childSessionKey };
}

describe("settleRequesterTurnAfterSessionSpawns", () => {
  it("persists explicit yield intent before settlement", () => {
    const entry = makeRun("run-child", false);
    const persistOrThrow = vi.fn();

    expect(
      markRequesterTurnYieldedInRuns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow,
      }),
    ).toBe(1);
    expect(entry.requesterTurnYielded).toBe(true);
    expect(persistOrThrow).toHaveBeenCalledOnce();
  });

  it("persists and schedules the exact yielded child batch", () => {
    const first = makeRun("run-b");
    const second = makeRun("run-a");
    const persistOrThrow = vi.fn();
    const schedule = vi.fn();

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(first), accepted(second)],
        runs: new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
        persistOrThrow,
        schedule,
      }),
    ).toBe(true);

    expect(persistOrThrow).toHaveBeenCalledOnce();
    expect(first.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(second.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(first.requesterSettleWake).toMatchObject({
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    });
    expect(first.requesterTurnRunId).toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("retires a completed yielded batch whose requester already produced its final", () => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    const schedule = vi.fn();

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow: vi.fn(),
        schedule,
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(entry.requesterTurnRunId).toBeUndefined();
    expect(entry.delivery?.requesterVisibleFinal).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another requester turn",
      (entry: SubagentRunRecord) => {
        entry.delivery!.requesterVisibleFinal!.requesterTurnRunId = "run-other";
      },
    ],
    [
      "changed child membership",
      (entry: SubagentRunRecord) => {
        entry.delivery!.requesterVisibleFinal!.batchRunIds.push("run-later");
      },
    ],
    [
      "unfinished cleanup",
      (entry: SubagentRunRecord) => {
        entry.cleanupCompletedAt = undefined;
      },
    ],
    [
      "unfinished delivery",
      (entry: SubagentRunRecord) => {
        entry.delivery!.status = "in_progress";
      },
    ],
    [
      "a replayed running child",
      (entry: SubagentRunRecord) => {
        entry.execution.status = "running";
      },
    ],
  ] as const)("keeps requester settlement when the final receipt has %s", (_, invalidate) => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    invalidate(entry);

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow: vi.fn(),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake?.requesterYieldBatch).toBe(true);
  });

  it.each([
    ["matches", "agent:main:subagent:worker", true],
    ["rejects", "agent:main:subagent:other", false],
  ] as const)("%s the exact child session after same-turn steer", (_, sessionKey, expected) => {
    const originalRunId = "run-original";
    const entry = makeRun("run-steered", false);
    entry.taskRunId = originalRunId;
    entry.childSessionKey = "agent:main:subagent:worker";
    const runs = new Map([[entry.runId, entry]]);
    const persistOrThrow = vi.fn();
    const schedule = vi.fn();

    expect(
      markRequesterTurnYieldedInRuns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        runs,
        persistOrThrow,
      }),
    ).toBe(1);
    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId: originalRunId, childSessionKey: sessionKey }],
        runs,
        persistOrThrow,
        schedule,
      }),
    ).toBe(expected);
    expect(persistOrThrow).toHaveBeenCalledTimes(expected ? 2 : 1);
    if (expected) {
      expect(entry.requesterSettleWake?.batchRunIds).toEqual([entry.runId]);
      expect(schedule).toHaveBeenCalledExactlyOnceWith(entry.runId, entry);
    } else {
      expect(entry.requesterSettleWake).toBeUndefined();
      expect(entry.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(schedule).not.toHaveBeenCalled();
    }
  });

  it("freezes active yielded children without scheduling before terminal delivery", () => {
    const entry = makeRun("run-child");
    entry.execution = { ...entry.execution, status: "running", endedAt: undefined };
    entry.delivery = { status: "pending" };
    const schedule = vi.fn();

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow: vi.fn(),
        schedule,
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake).toMatchObject({
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
    });
    expect(entry.requesterSettleWake?.afterRequesterYield).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("re-arms a completion whose delivery is in progress when its requester yields", () => {
    const entry = makeRun("run-child");
    entry.delivery = { status: "in_progress" };
    const schedule = vi.fn();

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow: vi.fn(),
        schedule,
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake).toMatchObject({
      requesterYieldBatch: true,
      afterRequesterYield: true,
    });
    expect(entry.delivery?.disposition).toBe("intentional_non_delivery");
    expect(schedule).toHaveBeenCalledExactlyOnceWith(entry.runId, entry);
  });

  it("persists a mixed delivered and in-progress yielded batch before scheduling", () => {
    const alpha = makeRun("run-alpha");
    const beta = makeRun("run-beta");
    beta.delivery = { status: "in_progress" };
    const calls: string[] = [];
    const persistOrThrow = vi.fn(() => calls.push("persist"));
    const schedule = vi.fn(() => calls.push("schedule"));

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(alpha), accepted(beta)],
        runs: new Map([
          [alpha.runId, alpha],
          [beta.runId, beta],
        ]),
        persistOrThrow,
        schedule,
      }),
    ).toBe(true);

    const frozenState = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: ["run-alpha", "run-beta"],
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    } as const;
    expect(alpha.requesterSettleWake).toEqual(frozenState);
    expect(beta.requesterSettleWake).toEqual(frozenState);
    expect(alpha.requesterTurnRunId).toBeUndefined();
    expect(beta.requesterTurnRunId).toBeUndefined();
    expect(beta.delivery?.disposition).toBe("intentional_non_delivery");
    expect(calls).toEqual(["persist", "schedule"]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(alpha.runId, alpha);
  });

  it.each([true, false])(
    "ignores same-turn non-completion spawns during settlement (yielded: %s)",
    (requesterYielded) => {
      const completion = makeRun("run-completion", false);
      const inline = makeRun("run-inline", false);
      inline.expectsCompletionMessage = false;
      inline.delivery = { status: "not_required" };
      const runs = new Map([
        [inline.runId, inline],
        [completion.runId, completion],
      ]);
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();

      if (requesterYielded) {
        expect(
          markRequesterTurnYieldedInRuns({
            requesterSessionKey: REQUESTER,
            requesterTurnRunId: REQUESTER_TURN,
            runs,
            persistOrThrow,
          }),
        ).toBe(1);
      }

      expect(
        settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          requesterYielded,
          acceptedSessionSpawns: [accepted(inline), accepted(completion)],
          runs,
          persistOrThrow,
          schedule,
        }),
      ).toBe(true);
      expect(persistOrThrow.mock.calls).toEqual(
        requesterYielded ? [[completion.runId], [completion.runId]] : [[completion.runId]],
      );
      if (requesterYielded) {
        expect(completion.requesterSettleWake).toMatchObject({
          batchRunIds: [completion.runId],
          afterRequesterYield: true,
        });
        expect(schedule).toHaveBeenCalledExactlyOnceWith(completion.runId, completion);
      } else {
        expect(completion.requesterSettleWake).toBeUndefined();
        expect(schedule).not.toHaveBeenCalled();
      }
      expect(inline.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(inline.requesterTurnYielded).toBeUndefined();
      expect(inline.requesterSettleWake).toBeUndefined();
    },
  );

  it("re-arms a delivered delete-mode row retained through requester settlement", () => {
    const entry = makeRun("run-delete");
    entry.cleanup = "delete";
    entry.cleanupCompletedAt = 2_100;
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs,
        persistOrThrow: vi.fn(),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.requesterSettleWake).toMatchObject({
      afterRequesterYield: true,
      retireAfterSettle: true,
    });
    expect(entry.retireAfterRequesterTurn).toBeUndefined();
  });

  it("retires a delete-mode row after its requester-owned final is already delivered", () => {
    const entry = makeRun("run-delete");
    entry.cleanup = "delete";
    entry.cleanupCompletedAt = 2_100;
    entry.retireAfterRequesterTurn = true;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    const runs = new Map([[entry.runId, entry]]);

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(entry)],
        runs,
        persistOrThrow: vi.fn(),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retires a completed delete-mode row after a normal requester answer", () => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: false,
        acceptedSessionSpawns: [accepted(entry)],
        runs,
        persistOrThrow: vi.fn(),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("rolls back every row when durable persistence fails", () => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);
    const failure = new Error("sqlite unavailable");

    expect(() =>
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: false,
        acceptedSessionSpawns: [accepted(entry)],
        runs,
        persistOrThrow: () => {
          throw failure;
        },
        schedule: vi.fn(),
      }),
    ).toThrow(failure);
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.requesterTurnRunId).toBe(REQUESTER_TURN);
    expect(entry.retireAfterRequesterTurn).toBe(true);
  });
});
