import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  clearTurnSendLedgerForRun,
  commitTurnSend,
  peekTurnSendCount,
  releaseTurnSend,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
  type TurnSendReservation,
  type TurnSendReserveResult,
} from "./turn-send-ledger.js";

// The idle TTL that once reset a live run's budget mid-turn was removed (#119992): a
// present (session, run) slot is now authoritative for the whole run, cleared only by
// clearTurnSendLedgerForRun at the run's terminal boundary. This test-only constant lets
// the long-idle regressions advance the clock past the old boundary and prove the budget
// no longer resets — the very case the old TTL bypassed.
const OLD_TTL_MS = 10 * 60_000;

// Stand-in for a provider target normalizer: case-fold and strip a leading "tg:"
// prefix, mirroring what a real telegram plugin normalizer does. Any other target
// (e.g. "reef:peer-agent") passes through unchanged, matching the real no-plugin
// fallback so the canonical-key test below stays valid.
vi.mock("../../infra/outbound/target-normalization.js", () => ({
  normalizeTargetForProvider: (_channel: string, raw?: string): string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const lowered = trimmed.toLowerCase();
    return lowered.startsWith("tg:") ? lowered.slice("tg:".length) : lowered;
  },
}));

type LedgerKey = { sessionKey: string; runId: string; targetKey: string };

// Assert a reserve succeeded and hand back the reservation, so a test that expected
// admission fails loudly at the reserve rather than at a later commit/release.
function expectReserved(result: TurnSendReserveResult): TurnSendReservation {
  if (result.status !== "reserved") {
    throw new Error(`expected a reserved reservation, got "${result.status}"`);
  }
  return result.reservation;
}

// The production reserve->await->settle round-trip collapsed for the counting tests:
// reserve, then immediately commit as if delivery landed. Returns the committed count.
function commitOne(
  key: LedgerKey,
  options: { maxPerTurn?: number; operationId?: string } = {},
): number {
  const reservation = expectReserved(reserveTurnSend(key, options));
  return commitTurnSend(reservation);
}

afterEach(() => {
  resetTurnSendLedgerForTest();
  vi.useRealTimers();
});

describe("turn-send-ledger", () => {
  it("counts committed sends per (runId, target) within one turn", () => {
    const base = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    expect(commitOne(base)).toBe(1);
    expect(commitOne(base)).toBe(2);
    expect(commitOne(base)).toBe(3);
  });

  it("keeps separate committed counts per target inside the same turn", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:b" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("starts a fresh count for a new run on the same session", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // A new run on the same session is a distinct ledger key, so it starts fresh.
    expect(commitOne({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(1);
  });

  it("isolates counts across sessions", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s2", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("keeps interleaved runs on one session isolated (A -> B -> A)", () => {
    // Concurrent foreground turns share a sessionKey but carry distinct runIds:
    // src/auto-reply/dispatch.freshness.test.ts:703 ("keeps concurrent foreground
    // finals isolated for different targets sharing a session", sharedSessionKey
    // = "agent:main:main") starts run A, completes run B on the same session, then
    // resumes A. B committing between A's sends must not evict A's slot, or A's
    // cap/nudge silently resets to 0 mid-turn.
    const session = "agent:main:main";
    const target = "tg:a";
    const runA = { sessionKey: session, runId: "run-A", targetKey: target };
    const runB = { sessionKey: session, runId: "run-B", targetKey: target };
    expect(commitOne(runA)).toBe(1);
    expect(commitOne(runB)).toBe(1);
    expect(commitOne(runA)).toBe(2);
    expect(peekTurnSendCount(runA)).toBe(2);
    expect(peekTurnSendCount(runB)).toBe(1);
  });

  it("peeks the committed count without mutating and returns 0 for a different turn", () => {
    commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // Peeking must not increment.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // A newer turn has no prior sends recorded.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(0);
    // Unknown session/target reads as zero.
    expect(peekTurnSendCount({ sessionKey: "s9", runId: "run-1", targetKey: "tg:a" })).toBe(0);
  });

  it("does not surface an in-flight reservation as a committed count", () => {
    const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    // A reservation is pending, not committed: peek reflects only landed sends.
    expectReserved(reserveTurnSend(key, {}));
    expect(peekTurnSendCount(key)).toBe(0);
  });

  it("keeps a capped run exhausted after a long idle wait past the old TTL (#119992)", () => {
    // Regression for the removed idle-TTL bypass. Under a hard cap of 1, the first send
    // commits and reaches the cap. The run then idles far past the old 10-minute TTL
    // (a slow tool wait) before its next same-target send. The slot must stay
    // authoritative — a distinct operation is still `exhausted` and the count is still 1,
    // never reset to a fresh budget. Drives the Date.now() default the pre-fix code read,
    // so this FAILS on pre-fix code (which pruned the slot and re-admitted the send).
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    expect(commitOne(key, { maxPerTurn: 1, operationId: "op-1" })).toBe(1);
    // Idle beyond the old TTL, then a genuinely new send to the same target this run.
    vi.setSystemTime(OLD_TTL_MS + 1);
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("builds the canonical channel/account/target key shared by both send tools", () => {
    // Byte-identical to resolveOutboundActionRoute in message-tool: an absent account
    // folds to "default" and the channel is normalized.
    expect(buildTurnSendTargetKey({ channel: "reef", target: "reef:peer-agent" })).toBe(
      "reef\u0000default\u0000reef:peer-agent",
    );
    expect(
      buildTurnSendTargetKey({ channel: "reef", accountId: "primary", target: "reef:peer-agent" }),
    ).toBe("reef\u0000primary\u0000reef:peer-agent");
  });

  it("canonicalizes the target so equivalent spellings share one ledger slot", () => {
    // Both spellings of one peer must produce a byte-identical key, otherwise
    // "TG:12345" and "12345" would occupy separate slots and bypass the nudge/cap.
    const prefixed = buildTurnSendTargetKey({ channel: "telegram", target: "TG:12345" });
    const bare = buildTurnSendTargetKey({ channel: "telegram", target: "12345" });
    expect(prefixed).toBe(bare);
    expect(prefixed).toBe("telegram\u0000default\u000012345");
  });
});

describe("turn-send-ledger session slot key", () => {
  it("builds the canonical agent-prefixed session slot key shared by both send tools", () => {
    // #119992: the message tool and conversations_send must scope the ledger by the
    // same `${agentId}\0${sessionKey}` slot. Keying one tool by the raw session key
    // and the other by this agent-prefixed key split one turn across two slots and let
    // alternating them evade the nudge/cap. A raw session key alone must not match.
    expect(buildTurnSendLedgerSessionKey("main", "agent:main:reef:direct:operator")).toBe(
      "main\u0000agent:main:reef:direct:operator",
    );
    expect(buildTurnSendLedgerSessionKey("main", "agent:main:reef:direct:operator")).not.toBe(
      "agent:main:reef:direct:operator",
    );
  });

  it("trims the session key and returns undefined when either component is absent", () => {
    // Fallback mirrors the message tool's original inline construction exactly: the
    // session key is trimmed, and a missing agent id or empty session key yields no
    // ledger scope (undefined), leaving the budget inert for that call.
    expect(buildTurnSendLedgerSessionKey("main", "  agent:main:main  ")).toBe(
      "main\u0000agent:main:main",
    );
    expect(buildTurnSendLedgerSessionKey(undefined, "agent:main:main")).toBeUndefined();
    expect(buildTurnSendLedgerSessionKey("main", undefined)).toBeUndefined();
    expect(buildTurnSendLedgerSessionKey("main", "   ")).toBeUndefined();
  });
});

describe("turn-send-ledger reservations", () => {
  const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };

  it("counts a pending reservation toward a positive cap before it settles", () => {
    // Reserve one send at a cap of 1: admitted, but committed is still 0 (nothing
    // landed yet).
    expectReserved(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }));
    expect(peekTurnSendCount(key)).toBe(0);
    // A second, distinct-op reserve BEFORE the first commits is exhausted — the
    // in-flight reservation already occupies the single cap slot. This is the race the
    // reserve/commit split closes: peek-then-record admitted both.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
  });

  it("moves a committed reservation into the committed count and returns it", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 2, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // commit then peek === committed count.
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("admits an already-committed operationId past the cap as a replay", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // The same op again, with the cap reached, is a replay (idempotent Gateway retry),
    // not exhausted: it must be admitted so an already-earned receipt is not suppressed.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }).status).toBe("replay");
    // A genuinely distinct op at the cap is still exhausted.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
  });

  it("rolls back a released reservation so the slot is free to reserve again", () => {
    const first = expectReserved(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }));
    // While it is pending the cap is reached...
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
    releaseTurnSend(first);
    // ...but a rollback frees the slot for a fresh reservation.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("reserved");
    // Release never touched committed: nothing landed.
    expect(peekTurnSendCount(key)).toBe(0);
  });

  it("is double-release safe and a release after commit does not decrement committed", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 2, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // Releasing an already-committed reservation, twice, must leave committed intact.
    releaseTurnSend(reservation);
    releaseTurnSend(reservation);
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("makes a repeat commit idempotent, reporting the committed count without double-counting", () => {
    const reservation = expectReserved(reserveTurnSend(key, {}));
    expect(commitTurnSend(reservation)).toBe(1);
    // A second commit neither re-increments nor throws.
    expect(commitTurnSend(reservation)).toBe(1);
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("never exhausts when maxPerTurn is undefined but still counts for the nudge", () => {
    // Media / no configured cap: admission is unconditional, yet counting continues so
    // the soft nudge still fires from the second send.
    expect(commitOne(key, {})).toBe(1);
    const second = reserveTurnSend(key, {});
    expect(second.status).toBe("reserved");
    expect(commitTurnSend(expectReserved(second))).toBe(2);
    expect(peekTurnSendCount(key)).toBe(2);
  });
});

describe("turn-send-ledger operation identity", () => {
  const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };

  it("counts an operationId once and treats a replay as admitted without re-counting", () => {
    expect(commitOne(key, { operationId: "op-1" })).toBe(1);
    // The same operationId is now committed, so a re-reserve is a replay, not a fresh
    // reservation, and the per-target count stays at 1.
    expect(reserveTurnSend(key, { operationId: "op-1" }).status).toBe("replay");
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("increments per distinct operationId to the same target", () => {
    expect(commitOne(key, { operationId: "op-1" })).toBe(1);
    expect(commitOne(key, { operationId: "op-2" })).toBe(2);
    expect(peekTurnSendCount(key)).toBe(2);
  });

  it("resets seen operations when the runId changes (new turn)", () => {
    commitOne(key, { operationId: "op-1" });
    // A new turn has no memory of the prior operationId, so it reserves fresh (not a
    // replay) and counts from 1.
    const nextTurn = { ...key, runId: "run-2" };
    expect(reserveTurnSend(nextTurn, { operationId: "op-1" }).status).toBe("reserved");
    expect(commitOne(nextTurn, { operationId: "op-1" })).toBe(1);
  });

  it("keeps seen operation ids isolated across interleaved runs on one session", () => {
    const session = "agent:main:main";
    const target = "tg:a";
    const runA = { sessionKey: session, runId: "run-A", targetKey: target };
    const runB = { sessionKey: session, runId: "run-B", targetKey: target };
    expect(commitOne(runA, { operationId: "op-a" })).toBe(1);
    expect(commitOne(runB, { operationId: "op-b" })).toBe(1);
    // op-a already committed for run A -> a re-reserve is an idempotent replay.
    expect(reserveTurnSend(runA, { operationId: "op-a" }).status).toBe("replay");
  });

  it("keeps a committed operationId a replay across a long idle wait in one run", () => {
    // Regression (#119992): seenOperations survives the whole run, not a rolling idle
    // window. After idling far past the old TTL, the SAME operationId is still an
    // idempotent replay (count unchanged) and a DISTINCT operation still counts forward —
    // pre-fix the slot expired and the id read as unseen, restarting the budget.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(commitOne(key, { operationId: "op-1" })).toBe(1);
    vi.setSystemTime(OLD_TTL_MS + 1);
    expect(reserveTurnSend(key, { operationId: "op-1" }).status).toBe("replay");
    expect(peekTurnSendCount(key)).toBe(1);
    expect(commitOne(key, { operationId: "op-2" })).toBe(2);
  });
});

describe("turn-send-ledger live-slot retention", () => {
  // The removed LRU cap evicted the oldest-touched slot once 2048 slots accumulated.
  // The victim could be a run that is still live but idle (a long tool wait while
  // 2049+ turns run concurrently): evicting it silently zeroed its committed counts
  // mid-turn and released its hard cap. Evicting a live slot can never be correct, so
  // terminal cleanup is now the ledger's only delete path — every live slot must be
  // retained no matter how many concurrent runs exist.
  const OLD_LRU_CAP = 2048;
  const slot = (i: number) => ({ sessionKey: "s1", runId: `run-${i}`, targetKey: "tg:a" });

  it("retains every live slot beyond the old LRU cap (no live-slot eviction)", () => {
    const total = OLD_LRU_CAP + 2;
    for (let i = 0; i < total; i++) {
      expect(commitOne(slot(i), {})).toBe(1);
    }
    // Every slot survives — including the oldest, which the old eviction deleted the
    // moment the cap was crossed.
    expect(peekTurnSendCount(slot(0))).toBe(1);
    expect(peekTurnSendCount(slot(1))).toBe(1);
    expect(peekTurnSendCount(slot(OLD_LRU_CAP))).toBe(1);
    expect(peekTurnSendCount(slot(total - 1))).toBe(1);
    // The oldest slot is still authoritative: its next send counts forward to 2; it was
    // not silently reset to a fresh budget.
    expect(commitOne(slot(0), {})).toBe(2);
    expect(peekTurnSendCount(slot(0))).toBe(2);
  });

  it("deletes a slot only at its run's terminal boundary (sole delete path)", () => {
    // A live slot must keep its committed counts, pending reservations, and seen
    // operation ids intact through unbounded churn on other (session, run) slots —
    // touches far beyond the old cap, in any order — and disappear only when its own
    // run clears it at the terminal boundary.
    const agentId = "main";
    const session = "agent:main:churn";
    const ledgerSessionKey = buildTurnSendLedgerSessionKey(agentId, session)!;
    const victim = { sessionKey: ledgerSessionKey, runId: "run-victim", targetKey: "tg:a" };
    expect(commitOne(victim, { maxPerTurn: 3, operationId: "op-victim" })).toBe(1);

    for (let i = 0; i < OLD_LRU_CAP + 16; i++) {
      commitOne(slot(i), {});
    }
    // Re-touch early slots too — order of access must not matter without eviction.
    expect(commitOne(slot(0), {})).toBe(2);

    expect(peekTurnSendCount(victim)).toBe(1);
    // Seen-operation identity survived the churn: the committed op replays, a distinct
    // op still reserves under the cap.
    expect(reserveTurnSend(victim, { maxPerTurn: 3, operationId: "op-victim" }).status).toBe(
      "replay",
    );
    expect(reserveTurnSend(victim, { maxPerTurn: 3, operationId: "op-other" }).status).toBe(
      "reserved",
    );

    // The terminal boundary deletes exactly the victim slot...
    clearTurnSendLedgerForRun({ agentId, sessionKey: session, runId: "run-victim" });
    expect(peekTurnSendCount(victim)).toBe(0);
    // ...and leaves every other slot — all live runs — untouched.
    expect(peekTurnSendCount(slot(0))).toBe(2);
    expect(peekTurnSendCount(slot(OLD_LRU_CAP + 15))).toBe(1);
  });
});

describe("turn-send-ledger run terminal cleanup", () => {
  it("clears only the exact (session, run) slot and leaves siblings intact", () => {
    // Cleanup must delete one composite (canonical session, run) slot — never a
    // concurrent run on the same session, nor the same run on a different session.
    const agentId = "main";
    const sessionA = "agent:main:a";
    const sessionB = "agent:main:b";
    const ledgerA = buildTurnSendLedgerSessionKey(agentId, sessionA)!;
    const ledgerB = buildTurnSendLedgerSessionKey(agentId, sessionB)!;
    const target = "tg:a";
    const aX = { sessionKey: ledgerA, runId: "run-X", targetKey: target };
    const aY = { sessionKey: ledgerA, runId: "run-Y", targetKey: target };
    const bX = { sessionKey: ledgerB, runId: "run-X", targetKey: target };
    commitOne(aX);
    commitOne(aY);
    commitOne(bX);

    // Clear (session A, run X) using the raw agentId + sessionKey the tools were built
    // with; the cleanup rebuilds the same canonical slot key internally.
    clearTurnSendLedgerForRun({ agentId, sessionKey: sessionA, runId: "run-X" });
    expect(peekTurnSendCount(aX)).toBe(0);
    // Same session, different run — untouched.
    expect(peekTurnSendCount(aY)).toBe(1);
    // Different session, same runId — untouched.
    expect(peekTurnSendCount(bX)).toBe(1);
  });

  it("is a harmless no-op for a missing slot or an unresolvable scope", () => {
    const agentId = "main";
    const session = "agent:main:a";
    const ledger = buildTurnSendLedgerSessionKey(agentId, session)!;
    const key = { sessionKey: ledger, runId: "run-X", targetKey: "tg:a" };
    commitOne(key);
    // Clearing an absent run, then re-clearing an already-cleared run, must not throw and
    // must not disturb the live slot / already-cleared slot.
    expect(() =>
      clearTurnSendLedgerForRun({ agentId, sessionKey: session, runId: "run-absent" }),
    ).not.toThrow();
    expect(peekTurnSendCount(key)).toBe(1);
    clearTurnSendLedgerForRun({ agentId, sessionKey: session, runId: "run-X" });
    expect(() =>
      clearTurnSendLedgerForRun({ agentId, sessionKey: session, runId: "run-X" }),
    ).not.toThrow();
    expect(peekTurnSendCount(key)).toBe(0);
    // A missing agent id yields no ledger scope, so cleanup is inert (no throw).
    expect(() => clearTurnSendLedgerForRun({ sessionKey: session, runId: "run-X" })).not.toThrow();
  });
});
