// ACPX tests cover legacy runTurn adaptation into the terminal result contract.
import { describe, expect, it, vi } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnInput } from "../runtime-api.js";
import { lazyStartRuntimeTurn } from "./runtime-turn.js";

function createLegacyRuntime(events: AcpRuntimeEvent[]): AcpRuntime {
  return {
    ensureSession: vi.fn(),
    async *runTurn() {
      yield* events;
    },
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const turnInput: AcpRuntimeTurnInput = {
  handle: {
    sessionKey: "agent:main:acp:test",
    backend: "test",
    runtimeSessionName: "test",
  },
  text: "hello",
  mode: "prompt",
  requestId: "request-1",
};

describe("lazyStartRuntimeTurn", () => {
  it.each(["cancel", "cancelled", "manual-cancel"])(
    "preserves %s cancellation from a legacy done event",
    async (stopReason) => {
      const turn = lazyStartRuntimeTurn(
        async () => createLegacyRuntime([{ type: "done", stopReason }]),
        turnInput,
      );

      expect(await turn.result).toEqual({ status: "cancelled", stopReason });
      const events: AcpRuntimeEvent[] = [];
      for await (const event of turn.events) {
        events.push(event);
      }
      expect(events).toEqual([]);
    },
  );
});
