// Covers run-indexed agent event delivery: bucket scoping, global-before-bucket
// ordering, and bucket lifetime. Separate from agent-events.test.ts so neither
// file needs a max-lines suppression.
import { beforeEach, describe, expect, test } from "vitest";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  onAgentEvent,
  onAgentEventForRun,
  resetAgentEventsForTest,
} from "./agent-events.js";
import { claimAgentRunContext, registerAgentRunContext } from "./agent-run-registry.js";

describe("run-indexed agent event listeners", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("delivers only the subscribed run's events", () => {
    registerAgentRunContext("run-a", { sessionKey: "session-a" });
    registerAgentRunContext("run-b", { sessionKey: "session-b" });
    const mine: number[] = [];
    const unsubscribe = onAgentEventForRun("run-a", (evt) => mine.push(evt.seq));

    emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "one" } });
    emitAgentEvent({ runId: "run-b", stream: "assistant", data: { text: "other run" } });
    emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "two" } });
    unsubscribe();
    emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "after" } });

    expect(mine).toEqual([1, 2]);
  });

  test("notifies global listeners before run-indexed listeners", () => {
    registerAgentRunContext("run-order", { sessionKey: "session-order" });
    const order: string[] = [];
    const stopRun = onAgentEventForRun("run-order", () => order.push("run"));
    const stopGlobal = onAgentEvent((evt) => {
      if (evt.runId === "run-order") {
        order.push("global");
      }
    });

    emitAgentEvent({ runId: "run-order", stream: "assistant", data: { text: "hi" } });
    stopRun();
    stopGlobal();

    // The bucket subscribed first, so insertion order alone would have put it
    // first. Globals must still win: a global listener may write state that a
    // run-scoped listener reads.
    expect(order).toEqual(["global", "run"]);
  });

  test("keeps sibling subscribers alive and reclaims the bucket only when empty", () => {
    registerAgentRunContext("run-shared", { sessionKey: "session-shared" });
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = onAgentEventForRun("run-shared", () => first.push("first"));
    const stopSecond = onAgentEventForRun("run-shared", () => second.push("second"));

    emitAgentEvent({ runId: "run-shared", stream: "assistant", data: { text: "both" } });
    stopFirst();
    // Unsubscribing one subscriber must not drop the bucket the other still uses.
    emitAgentEvent({ runId: "run-shared", stream: "assistant", data: { text: "still here" } });
    stopSecond();
    emitAgentEvent({ runId: "run-shared", stream: "assistant", data: { text: "gone" } });

    expect(first).toEqual(["first"]);
    expect(second).toEqual(["second", "second"]);

    // A fresh subscription after the bucket was reclaimed still receives events.
    const revived: string[] = [];
    const stopRevived = onAgentEventForRun("run-shared", () => revived.push("revived"));
    emitAgentEvent({ runId: "run-shared", stream: "assistant", data: { text: "again" } });
    stopRevived();
    expect(revived).toEqual(["revived"]);
  });

  test("tolerates a repeated unsubscribe without disturbing a later subscriber", () => {
    registerAgentRunContext("run-repeat", { sessionKey: "session-repeat" });
    const stale = onAgentEventForRun("run-repeat", () => {});
    stale();
    const seen: string[] = [];
    const stop = onAgentEventForRun("run-repeat", () => seen.push("seen"));
    stale();

    emitAgentEvent({ runId: "run-repeat", stream: "assistant", data: { text: "hi" } });
    stop();

    expect(seen).toEqual(["seen"]);
  });

  test("routes owner-scoped emissions to run-indexed listeners", () => {
    const claimId = claimAgentRunContext(
      "run-owner",
      { sessionKey: "session-owner" },
      { exclusive: true, trackOwner: true },
    )!;
    const seen: string[] = [];
    const stop = onAgentEventForRun("run-owner", () => seen.push("seen"));

    emitAgentEventForOwner(
      { runId: "run-owner", stream: "assistant", data: { text: "owned" } },
      claimId,
    );
    stop();

    expect(seen).toEqual(["seen"]);
  });
});
