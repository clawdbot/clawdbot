import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  onAgentEvent,
  onAgentEventForRun,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
} from "./agent-events.js";
import { claimAgentRunContext, registerAgentRunContext } from "./agent-run-registry.js";

describe("run-indexed agent event listeners", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });
  afterEach(() => {
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

  test("preserves mixed global and run listener registration order", () => {
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

    expect(order).toEqual(["run", "global"]);
  });

  test.each(["global", "run"] as const)(
    "visits a new %s listener added by the last callback, even when that callback throws",
    (scope) => {
      const order: string[] = [];
      const addLate = () => {
        order.push("first");
        if (scope === "global") {
          onAgentEvent(() => order.push("late"));
        } else {
          onAgentEventForRun("run-live", () => order.push("late"));
        }
        throw new Error("listener failed after registering its successor");
      };
      if (scope === "global") {
        onAgentEventForRun("run-live", addLate);
      } else {
        onAgentEvent(addLate);
      }
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      expect(order).toEqual(["first", "late"]);
    },
  );

  test.each([
    ["global", false],
    ["global", true],
    ["run", false],
    ["run", true],
  ] as const)(
    "skips a deleted %s callback and appends its replacement (re-add=%s)",
    (scope, readd) => {
      const order: string[] = [];
      const subscribe = (listener: () => void) =>
        scope === "global" ? onAgentEvent(listener) : onAgentEventForRun("run-live", listener);
      const replaced = () => order.push("re-added");
      let stopReplaced: () => void;
      onAgentEventForRun("run-live", () => {
        order.push("first");
        stopReplaced();
        if (readd) {
          subscribe(replaced);
        }
      });
      stopReplaced = subscribe(replaced);
      onAgentEvent(() => order.push("middle"));
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      expect(order).toEqual(readd ? ["first", "middle", "re-added"] : ["first", "middle"]);
    },
  );

  test.each(["global", "run"] as const)(
    "deduplicates %s callbacks and preserves same-bucket unsubscribe handles",
    (scope) => {
      const subscribe = (listener: () => void) =>
        scope === "global" ? onAgentEvent(listener) : onAgentEventForRun("run-live", listener);
      const seen: string[] = [];
      const listener = () => seen.push("event");
      subscribe(() => {});
      const stopFirst = subscribe(listener);
      const stopDuplicate = subscribe(listener);
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      stopFirst();
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      subscribe(listener);
      stopFirst();
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      stopDuplicate();
      expect(seen).toEqual(["event"]);
    },
  );

  test("shares global callback identity with runtime subscriptions", () => {
    const seen: string[] = [];
    const listener = () => seen.push("event");
    const stop = onAgentEvent(listener);
    onAgentRuntimeEvent(listener);
    emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
    stop();
    emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
    expect(seen).toEqual(["event"]);
  });

  test.each([false, true])(
    "keeps reset-during-dispatch live (preserve=%s)",
    (preserveListeners) => {
      const order: string[] = [];
      onAgentEventForRun("run-live", () => {
        order.push("first");
        resetAgentEventsForTest({ preserveListeners });
        onAgentEvent(() => order.push("new-global"));
        onAgentEventForRun("run-live", () => order.push("new-run"));
      });
      onAgentEvent(() => order.push("old-global"));
      onAgentEventForRun("run-live", () => order.push("old-run"));
      emitAgentEvent({ runId: "run-live", stream: "assistant", data: {} });
      expect(order).toEqual(
        preserveListeners
          ? ["first", "old-global", "old-run", "new-global", "new-run"]
          : ["first", "new-global", "new-run"],
      );
    },
  );

  test.each([false, true])(
    "reselects a mutated run cohort without revisiting earlier positions (pending=%s)",
    (hasPendingOriginalRun) => {
      const order: string[] = [];
      onAgentEventForRun("run-b", () => order.push("earlier-b"));
      onAgentEventForRun("run-a", () => order.push("first-a"));
      onAgentEvent((event) => {
        order.push("global");
        event.runId = "run-b";
      });
      if (hasPendingOriginalRun) {
        onAgentEventForRun("run-a", () => order.push("later-a"));
      }
      onAgentEventForRun("run-b", () => order.push("later-b"));
      emitAgentEvent({ runId: "run-a", stream: "assistant", data: {} });
      expect(order).toEqual(["first-a", "global", "later-b"]);
    },
  );

  test("retains independent nested cursors while new callbacks join both emissions", () => {
    const order: string[] = [];
    onAgentEventForRun("run-live", (event) => {
      order.push(`first:${String(event.data.text)}`);
      if (event.data.text === "outer") {
        emitAgentEvent({ runId: "run-live", stream: "assistant", data: { text: "inner" } });
      } else {
        onAgentEventForRun("run-live", (next) => order.push(`new-run:${String(next.data.text)}`));
        onAgentEvent((next) => order.push(`new-global:${String(next.data.text)}`));
      }
    });
    onAgentEvent((event) => order.push(`global:${String(event.data.text)}`));
    emitAgentEvent({ runId: "run-live", stream: "assistant", data: { text: "outer" } });
    expect(order).toEqual([
      "first:outer",
      "first:inner",
      "global:inner",
      "new-run:inner",
      "new-global:inner",
      "global:outer",
      "new-run:outer",
      "new-global:outer",
    ]);
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
