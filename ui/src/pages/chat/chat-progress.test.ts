import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkingProgress, resolveTurnRecap } from "./chat-progress.ts";

const SESSION = "agent:main:main";
const PREVIOUS_ENDED_AT = 900_000;
const RUN_ENDED_AT = 1_000_000;

const doneRow = (endedAt: number, runtimeMs = 51_000, outputTokens?: number) => ({
  status: "done",
  endedAt,
  runtimeMs,
  ...(outputTokens === undefined ? {} : { outputTokens }),
});

describe("resolveTurnRecap", () => {
  beforeEach(() => resetWorkingProgress());
  afterEach(() => resetWorkingProgress());

  it("resolves once a fresh terminal stamp lands, then sticks", () => {
    // Indicator up: previous run's terminal stamp becomes the baseline.
    expect(resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    // Indicator settles but only the stale row is visible so far.
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    // Fresh terminal patch: recap resolves and keeps resolving.
    const row = doneRow(RUN_ENDED_AT, 51_000, 485);
    expect(resolveTurnRecap(SESSION, false, row)).toEqual({
      runtimeMs: 51_000,
      outputTokens: 485,
    });
    expect(resolveTurnRecap(SESSION, false, row)).toEqual({
      runtimeMs: 51_000,
      outputTokens: 485,
    });
  });

  it("rejects the previous turn's row even seconds after this run started", () => {
    resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
    // Rapid back-to-back turns: the old done row stays stale forever, and so
    // does any regressed (out-of-order) stamp.
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT - 5_000))).toBeNull();
  });

  it("expires an unresolved watch instead of matching a later run", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      // A queued send showed the claw but the run never started.
      resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
      expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
      vi.advanceTimersByTime(31_000);
      expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
      // A cron/background completion minutes later cannot claim the turn.
      expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes the watch on a fresh done row without runtime data", () => {
    resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
    expect(resolveTurnRecap(SESSION, false, { status: "done", endedAt: RUN_ENDED_AT })).toBeNull();
    // The watch concluded; a later completion cannot attach.
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT + 1_000))).toBeNull();
  });

  it("treats a cleared baseline (run start patch seen) as stale-free", () => {
    // Start patch cleared endedAt before the watch began.
    expect(resolveTurnRecap(SESSION, true, { status: "running" })).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 2_000))).toEqual({
      runtimeMs: 2_000,
      outputTokens: null,
    });
  });

  it("never resolves without having watched a working indicator", () => {
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT))).toBeNull();
  });

  it("consumes a watch whose baseline row was never observed", () => {
    // Session row unavailable for the entire watch (capped list, still loading).
    expect(resolveTurnRecap(SESSION, true, undefined)).toBeNull();
    // The row appears only after settle, carrying the PREVIOUS run's stamp:
    // with no baseline it must not pass as this turn's terminal.
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT))).toBeNull();
  });

  it("adopts the first row observed mid-watch as the baseline", () => {
    expect(resolveTurnRecap(SESSION, true, undefined)).toBeNull();
    // Row loads while the claw is still up, showing the previous stamp.
    expect(resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    // Normal settle: only a fresh stamp resolves.
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 6_000))).toEqual({
      runtimeMs: 6_000,
      outputTokens: null,
    });
  });

  it("forfeits the turn when a terminal stamp changes mid-watch", () => {
    // Watch starts after the run-start patch cleared endedAt.
    expect(resolveTurnRecap(SESSION, true, { status: "running" })).toBeNull();
    // A terminal lands while the claw is still up: attribution is ambiguous
    // (early own-terminal, delayed prior run, other device) — consume quietly.
    expect(resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(PREVIOUS_ENDED_AT))).toBeNull();
    // Later stamps (e.g. a cron run) must not attach to the forfeited turn.
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 4_000))).toBeNull();
  });

  it("forfeits a failed turn whose terminal raced the indicator", () => {
    resolveTurnRecap(SESSION, true, { status: "running" });
    // The watched run fails while its claw is still visible.
    resolveTurnRecap(SESSION, true, { status: "failed", endedAt: RUN_ENDED_AT });
    expect(
      resolveTurnRecap(SESSION, false, { status: "failed", endedAt: RUN_ENDED_AT }),
    ).toBeNull();
    // A background run's later success cannot masquerade as this turn.
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT + 60_000))).toBeNull();
  });

  it("freezes the first resolved recap against later unwatched terminals", () => {
    resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
    const settled = resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 51_000, 485));
    expect(settled).toEqual({ runtimeMs: 51_000, outputTokens: 485 });
    // A background/cron run finishing later must not rewrite the recap.
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT + 90_000, 7_000, 42))).toEqual(
      settled,
    );
  });

  it("hides the recap as soon as the next run's indicator appears", () => {
    resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 51_000, 485))).toEqual({
      runtimeMs: 51_000,
      outputTokens: 485,
    });
    // Next turn: indicator visible again — recap gone before its terminal row changes.
    expect(resolveTurnRecap(SESSION, true, doneRow(RUN_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT))).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT + 1_000, 2_000, 12))).toEqual({
      runtimeMs: 2_000,
      outputTokens: 12,
    });
  });

  it("stays quiet for failed runs but ignores stale failed rows", () => {
    resolveTurnRecap(SESSION, true, {
      status: "failed",
      endedAt: PREVIOUS_ENDED_AT,
    });
    // Stale failed row from before this run must not consume the watch.
    expect(
      resolveTurnRecap(SESSION, false, { status: "failed", endedAt: PREVIOUS_ENDED_AT }),
    ).toBeNull();
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT, 3_000))).toEqual({
      runtimeMs: 3_000,
      outputTokens: null,
    });
  });

  it("consumes the watch on a fresh failed row", () => {
    resolveTurnRecap(SESSION, true, doneRow(PREVIOUS_ENDED_AT));
    expect(
      resolveTurnRecap(SESSION, false, { status: "failed", endedAt: RUN_ENDED_AT }),
    ).toBeNull();
    // A later done stamp belongs to some other run; the watch is gone.
    expect(resolveTurnRecap(SESSION, false, doneRow(RUN_ENDED_AT + 1_000))).toBeNull();
  });
});
