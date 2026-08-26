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

  test("delivers only its own run's events while two CLI runs stream concurrently", async () => {
    registerAgentRunContext("run-a", { sessionKey: "session-a" });
    registerAgentRunContext("run-b", { sessionKey: "session-b" });
    const deliveredA: string[] = [];
    const deliveredB: string[] = [];
    const bridgeA = textBridge("run-a", deliveredA);
    const bridgeB = textBridge("run-b", deliveredB);

    emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "a1" } });
    emitAgentEvent({ runId: "run-b", stream: "assistant", data: { text: "b1" } });
    emitAgentEvent({ runId: "run-a", stream: "assistant", data: { text: "a2" } });
    await bridgeA.drain();
    await bridgeB.drain();
    bridgeA.unsubscribe();
    bridgeB.unsubscribe();

    expect(deliveredA).toEqual(["a1", "a2"]);
    expect(deliveredB).toEqual(["b1"]);
  });

  test("subscribes into its run's bucket rather than the global listener set", () => {
    registerAgentRunContext("run-scope", { sessionKey: "session-scope" });
    const order: string[] = [];
    // Registered first, so insertion order alone would run the bridge first.
    // Run-indexed listeners always follow every global listener, so the bridge
    // trailing here is what proves it is no longer a global subscriber that
    // every other run's events would still have to walk.
    const bridge = createAgentEventBridge<string>({
      runId: "run-scope",
      read: () => {
        order.push("bridge");
        return undefined;
      },
      deliver: async () => {},
    });
    const stopGlobal = onAgentEvent(() => order.push("global"));

    emitAgentEvent({ runId: "run-scope", stream: "assistant", data: { text: "hi" } });
    stopGlobal();
    bridge.unsubscribe();

    expect(order).toEqual(["global", "bridge"]);
  });
});
