import { describe, expect, it, vi } from "vitest";
import { agentEndCancellation as state } from "../../agents/harness/agent-end-cancellation.js";

describe("skill experience review cancellation state", () => {
  it("routes cancellation and suppresses exactly one failed terminal event", async () => {
    const cancelReview = vi.fn(() => true);
    state.register(cancelReview);

    const reservation = state.reserve(" agent:main:main ", ["stopped-run"]);
    expect(state.reconcile(reservation, ["stopped-run"])).toBe(true);
    expect(cancelReview).toHaveBeenCalledWith("agent:main:main");
    await expect(
      state.consumeStoppedTerminal("agent:main:main", "stopped-run", true),
    ).resolves.toBe(false);
    await expect(state.consumeStoppedTerminal("agent:main:main", "other-run", false)).resolves.toBe(
      false,
    );
    await expect(
      state.consumeStoppedTerminal("agent:main:main", "stopped-run", false),
    ).resolves.toBe(true);
    await expect(
      state.consumeStoppedTerminal("agent:main:main", "stopped-run", false),
    ).resolves.toBe(false);
  });

  it("does not suppress a later failure when the foreground abort did not succeed", async () => {
    state.register(() => false);

    const reservation = state.reserve("agent:main:no-active-run", []);
    expect(state.reconcile(reservation, [])).toBe(false);
    await expect(
      state.consumeStoppedTerminal("agent:main:no-active-run", "later-run", false),
    ).resolves.toBe(false);
  });

  it("bounds stop markers that never receive a terminal event", async () => {
    state.register(() => false);
    const sessionKeys = Array.from(
      { length: 33 },
      (_, index) => `agent:main:unreported-stop-${index}`,
    );

    for (const sessionKey of sessionKeys) {
      const reservation = state.reserve(sessionKey, [`run-${sessionKey}`]);
      state.reconcile(reservation, [`run-${sessionKey}`]);
    }

    await expect(
      state.consumeStoppedTerminal(sessionKeys[0], `run-${sessionKeys[0]}`, false),
    ).resolves.toBe(false);
    for (const sessionKey of sessionKeys.slice(1)) {
      await expect(
        state.consumeStoppedTerminal(sessionKey, `run-${sessionKey}`, false),
      ).resolves.toBe(true);
    }
  });

  it("waits for an exact pending abort and suppresses only when it succeeds", async () => {
    const reservation = state.reserve("agent:main:reserved-success", ["run-success"]);
    const terminal = state.consumeStoppedTerminal(
      "agent:main:reserved-success",
      "run-success",
      false,
    );
    state.reconcile(reservation, ["run-success"]);
    await expect(terminal).resolves.toBe(true);
  });

  it("releases an exact pending terminal when abort fails", async () => {
    const reservation = state.reserve("agent:main:reserved-failure", ["run-failure"]);
    const terminal = state.consumeStoppedTerminal(
      "agent:main:reserved-failure",
      "run-failure",
      false,
    );
    state.reconcile(reservation, []);
    await expect(terminal).resolves.toBe(false);
  });

  it("evicts only one membership from a multi-run token before failed reconciliation", async () => {
    const sessionKey = "agent:main:busy-reservations";
    const reservation = state.reserve(sessionKey, ["run-0", "run-1"]);
    const run0 = state.consumeStoppedTerminal(sessionKey, "run-0", false);
    const run1 = state.consumeStoppedTerminal(sessionKey, "run-1", false);
    const filler = state.reserve(
      sessionKey,
      Array.from({ length: 31 }, (_, index) => `fill-${index}`),
    );
    await expect(run0).resolves.toBe(false);
    let run1Settled = false;
    void run1.then(() => {
      run1Settled = true;
    });
    await Promise.resolve();
    expect(run1Settled).toBe(false);
    state.reconcile(reservation, []);
    await expect(run1).resolves.toBe(false);
    state.reconcile(filler, []);
  });

  it("can confirm a surviving membership after another membership is evicted", async () => {
    const sessionKey = "agent:main:busy-success";
    const reservation = state.reserve(sessionKey, ["run-0", "run-1"]);
    const run0 = state.consumeStoppedTerminal(sessionKey, "run-0", false);
    const run1 = state.consumeStoppedTerminal(sessionKey, "run-1", false);
    const filler = state.reserve(
      sessionKey,
      Array.from({ length: 31 }, (_, index) => `fill-${index}`),
    );
    await expect(run0).resolves.toBe(false);
    state.reconcile(reservation, ["run-1"]);
    await expect(run1).resolves.toBe(true);
    state.reconcile(filler, []);
  });

  it("keeps confirmation monotonic across a later duplicate attempt failure", async () => {
    const sessionKey = "agent:main:monotonic-success";
    const first = state.reserve(sessionKey, ["run"]);
    state.reconcile(first, ["run"]);
    const duplicate = state.reserve(sessionKey, ["run"]);
    state.reconcile(duplicate, []);
    await expect(state.consumeStoppedTerminal(sessionKey, "run", false)).resolves.toBe(true);
  });

  it("keeps a newer success when an older overlapping attempt fails late", async () => {
    const sessionKey = "agent:main:overlapping-attempts";
    const older = state.reserve(sessionKey, ["run"]);
    const newer = state.reserve(sessionKey, ["run"]);
    const terminal = state.consumeStoppedTerminal(sessionKey, "run", false);
    state.reconcile(newer, ["run"]);
    state.reconcile(older, []);
    await expect(terminal).resolves.toBe(true);
  });

  it("dedupes aliases within one attempt and ignores duplicate reconcile", async () => {
    const sessionKey = "agent:main:alias-dedupe";
    const reservation = state.reserve(sessionKey, ["run", "run"]);
    expect(state.reconcile(reservation, ["run"])).toBe(false);
    expect(state.reconcile(reservation, [])).toBe(false);
    await expect(state.consumeStoppedTerminal(sessionKey, "run", false)).resolves.toBe(true);
    await expect(state.consumeStoppedTerminal(sessionKey, "run", false)).resolves.toBe(false);
  });
});
