// Covers the shared CLI delivery bridge's subscription scope. Every concurrent
// CLI run builds up to eight of these bridges, so a bridge that subscribes
// globally and discards foreign runs makes per-delta cost grow with agent count.
import { beforeEach, describe, expect, test } from "vitest";
import { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createAgentEventBridge } from "./agent-event-bridge.js";

function textBridge(runId: string, sink: string[]) {
  return createAgentEventBridge<string>({
    runId,
    read: (evt) => (typeof evt.data.text === "string" ? evt.data.text : undefined),
    deliver: async (text) => {
      sink.push(text);
    },
  });
}

describe("agent event delivery bridge", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test.each([1, 4, 16, 64])(
    "isolates every delivery bridge while %s CLI runs stream interleaved events",
    async (runs) => {
      let predicateReads = 0;
      const bridges = Array.from({ length: runs }, (_, runIndex) => {
        const runId = `run-${runIndex}`;
        registerAgentRunContext(runId, { sessionKey: `session-${runIndex}` });
        return Array.from({ length: 8 }, (_, bridgeIndex) => {
          const delivered: string[] = [];
          const bridge = createAgentEventBridge<string>({
            get runId() {
              predicateReads++;
              return runId;
            },
            read: (event) => (typeof event.data.text === "string" ? event.data.text : undefined),
            deliver: async (text) => {
              delivered.push(text);
            },
          });
          return { ...bridge, delivered, runIndex, bridgeIndex };
        });
      }).flat();
      try {
        predicateReads = 0;
        emitAgentEvent({ runId: "run-0", stream: "assistant", data: { text: "a1" } });
        // Source-pinned work measurement only: hoisting the filter can change this
        // count without changing dispatch complexity. Output assertions own the test.
        console.info("bridge predicate-read diagnostic (not latency)", {
          runs,
          bridgesPerRun: 8,
          predicateReads,
        });
        emitAgentEvent({ runId: "run-1", stream: "assistant", data: { text: "b1" } });
        emitAgentEvent({ runId: "run-0", stream: "assistant", data: { text: "a2" } });
        await Promise.all(bridges.map((bridge) => bridge.drain()));
        for (const { delivered, runIndex, bridgeIndex } of bridges) {
          expect(delivered, `run-${runIndex}/bridge-${bridgeIndex}`).toEqual(
            runIndex === 0 ? ["a1", "a2"] : runIndex === 1 ? ["b1"] : [],
          );
        }
      } finally {
        for (const bridge of bridges) {
          bridge.unsubscribe();
        }
      }
    },
  );

  test("keeps stream delivery order when a later global listener emits another event", async () => {
    registerAgentRunContext("run-nested", { sessionKey: "session-nested" });
    const delivered: string[] = [];
    const bridge = textBridge("run-nested", delivered);
    const stopGlobal = onAgentEvent((evt) => {
      if (evt.runId === "run-nested" && evt.data.text === "outer") {
        emitAgentEvent({ runId: "run-nested", stream: "assistant", data: { text: "inner" } });
      }
    });
    try {
      emitAgentEvent({ runId: "run-nested", stream: "assistant", data: { text: "outer" } });
      await bridge.drain();
      expect(delivered).toEqual(["outer", "inner"]);
    } finally {
      stopGlobal();
      bridge.unsubscribe();
    }
  });

  test("delivers the current event before a later global listener unsubscribes the bridge", async () => {
    registerAgentRunContext("run-unsubscribe", { sessionKey: "session-unsubscribe" });
    const delivered: string[] = [];
    const bridge = textBridge("run-unsubscribe", delivered);
    const stopGlobal = onAgentEvent((evt) => {
      if (evt.runId === "run-unsubscribe") {
        bridge.unsubscribe();
      }
    });
    try {
      emitAgentEvent({ runId: "run-unsubscribe", stream: "assistant", data: { text: "first" } });
      emitAgentEvent({ runId: "run-unsubscribe", stream: "assistant", data: { text: "second" } });
      await bridge.drain();
      expect(delivered).toEqual(["first"]);
    } finally {
      stopGlobal();
      bridge.unsubscribe();
    }
  });

  test("routes a changed event identity only to later matching bridges", async () => {
    registerAgentRunContext("run-a", { sessionKey: "session-a" });
    registerAgentRunContext("run-b", { sessionKey: "session-b" });
    const earlierB: string[] = [];
    const laterB: string[] = [];
    const laterA: string[] = [];
    const first = textBridge("run-b", earlierB);
    const stopGlobal = onAgentEvent((event) => {
      event.runId = "run-b";
    });
    const second = textBridge("run-b", laterB);
    const third = textBridge("run-a", laterA);
    try {
      emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "changed" } });
      await Promise.all([first.drain(), second.drain(), third.drain()]);
      expect(earlierB).toEqual([]);
      expect(laterB).toEqual(["changed"]);
      expect(laterA).toEqual([]);
    } finally {
      stopGlobal();
      first.unsubscribe();
      second.unsubscribe();
      third.unsubscribe();
    }
  });
});
