// Covers lifecycle-rotation handler ordering: a relay admitted by an earlier
// same-rotation handler must survive this module's own rotation sweep.
import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerNativeHookRelay, testing } from "./native-hook-relay.js";

const lifecycleMock = vi.hoisted(() => {
  let generationSequence = 0;
  let generation = `test-generation-${generationSequence}`;
  const handlers = new Map<string, (nextGeneration: string) => void>();
  return {
    get: () => generation,
    isCurrent: (candidate: string) => candidate === generation,
    register: (key: string, handler: (nextGeneration: string) => void) => {
      handlers.set(key, handler);
    },
    // Re-inserts an already-registered handler at the end so a handler
    // registered afterward runs first, reproducing "an earlier same-rotation
    // handler admits a relay" without depending on real cross-module order.
    runHandlerLast: (key: string) => {
      const handler = handlers.get(key);
      if (!handler) {
        return;
      }
      handlers.delete(key);
      handlers.set(key, handler);
    },
    rotate: () => {
      generationSequence += 1;
      generation = `test-generation-${generationSequence}`;
      for (const handler of handlers.values()) {
        handler(generation);
      }
      return generation;
    },
  };
});

vi.mock("../../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-events.js")>()),
  getAgentEventLifecycleGeneration: lifecycleMock.get,
  isAgentEventLifecycleGenerationCurrent: lifecycleMock.isCurrent,
  registerAgentEventLifecycleRotationHandler: lifecycleMock.register,
  rotateAgentEventLifecycleGeneration: lifecycleMock.rotate,
}));

afterEach(() => {
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay lifecycle rotation ordering", () => {
  it("preserves a relay admitted by an earlier handler during the same rotation", () => {
    lifecycleMock.register("earlier-relay-admitter", () => {
      registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-admitted-mid-rotation",
        sessionId: "session-1",
        runId: "run-admitted-mid-rotation",
        allowedEvents: ["pre_tool_use"],
      });
    });
    // Registered after, so without this reorder it would run after (not
    // before) the relay-admitting handler and never observe the new relay.
    lifecycleMock.runHandlerLast("native-hook-relays");

    rotateAgentEventLifecycleGeneration();

    expect(
      testing.getNativeHookRelayRegistrationForTests("codex-admitted-mid-rotation"),
    ).toBeDefined();
  });
});
