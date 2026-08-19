import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { isOneShotTurn } from "./run-attempt.js";

/**
 * Regression guard for openclaw-81h9.
 *
 * `oneShot` tells the bridge to close its subprocess the moment this turn ends.
 * It must mean "no follow-up turn will ever arrive on this thread" (finality),
 * NOT "this session has its own transcript" (provenance).
 *
 * `spawnedBy` was previously folded into the predicate. It is provenance: a
 * persisted column on the session row, so it is set on every turn of a spawned
 * session for that session's whole life. Spawned sessions are conversational
 * (sessions_send delivers follow-up turns to them), so treating them as final
 * respawned their subprocess every turn and killed anything they backgrounded.
 */
const base = { trigger: undefined } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;

function withTrigger(trigger: string | undefined): Pick<EmbeddedRunAttemptParams, "trigger"> {
  return { ...base, trigger } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
}

describe("isOneShotTurn", () => {
  it("is true for heartbeat and cron — each wake is its own final turn", () => {
    expect(isOneShotTurn(withTrigger("heartbeat"))).toBe(true);
    expect(isOneShotTurn(withTrigger("cron"))).toBe(true);
  });

  it("is false for a user-driven exchange and its continuations", () => {
    for (const trigger of ["user", "manual", "memory", "overflow"]) {
      expect(isOneShotTurn(withTrigger(trigger))).toBe(false);
    }
    expect(isOneShotTurn(withTrigger(undefined))).toBe(false);
  });

  it("does NOT treat a spawned session as one-shot", () => {
    // The load-bearing assertion. A spawned child on an ordinary trigger must
    // retain its attempt so it can receive a follow-up turn and so work it
    // backgrounded survives to that turn. Re-adding spawnedBy to the predicate
    // fails here.
    const spawned = {
      ...withTrigger("user"),
      spawnedBy: "agent:tank:direct:eddie",
    } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
    expect(isOneShotTurn(spawned)).toBe(false);
  });

  it("still treats a spawned HEARTBEAT turn as one-shot", () => {
    // Finality wins when it genuinely applies: a heartbeat wake is final
    // whether or not the session it runs in was spawned.
    const spawnedHeartbeat = {
      ...withTrigger("heartbeat"),
      spawnedBy: "agent:tank:direct:eddie",
    } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
    expect(isOneShotTurn(spawnedHeartbeat)).toBe(true);
  });
});
