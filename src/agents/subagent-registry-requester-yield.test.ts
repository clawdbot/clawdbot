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
    endedAt: 2_000,
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

  it("freezes active yielded children without scheduling before terminal delivery", () => {
    const entry = makeRun("run-child");
    entry.endedAt = undefined;
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
    expect(schedule).not.toHaveBeenCalled();
  });

  it("ignores accepted spawns that do not produce completion messages", () => {
    const completion = makeRun("run-completion");
    const inline = makeRun("run-inline");
    inline.requesterTurnRunId = undefined;
    inline.expectsCompletionMessage = false;
    inline.delivery = { status: "not_required" };

    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(completion), accepted(inline)],
        runs: new Map([
          [completion.runId, completion],
          [inline.runId, inline],
        ]),
        persistOrThrow: vi.fn(),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    expect(completion.requesterSettleWake?.afterRequesterYield).toBe(true);
    expect(inline.requesterSettleWake).toBeUndefined();
  });

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
