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
  it("preserves explicit submission authority across an asynchronously resolved runtime", async () => {
    const turn = lazyStartRuntimeTurn(
      async () => ({
        ensureSession: vi.fn(),
        startTurn: (input) => ({
          requestId: input.requestId,
          promptSubmission: Promise.resolve("submitted" as const),
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const }),
          cancel: vi.fn(async () => {}),
          closeStream: vi.fn(async () => {}),
        }),
        runTurn: vi.fn(),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
      turnInput,
    );

    await expect(turn.promptSubmission).resolves.toBe("submitted");
    await expect(turn.result).resolves.toEqual({ status: "completed" });
  });

  it("projects unknown readiness when the pinned runtime cannot prove prompt submission", async () => {
    const turn = lazyStartRuntimeTurn(
      async () => createLegacyRuntime([{ type: "done", stopReason: "end_turn" }]),
      turnInput,
    );

    await expect(turn.promptSubmission).resolves.toBe("unknown");
    await expect(turn.result).resolves.toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it("does not reinterpret an undeclared readiness lookalike as submission authority", async () => {
    const runtime: AcpRuntime = {
      ensureSession: vi.fn(),
      startTurn: (input) =>
        Object.assign(
          {
            requestId: input.requestId,
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed" as const }),
            cancel: vi.fn(async () => {}),
            closeStream: vi.fn(async () => {}),
          },
          { promptStarted: Promise.resolve() },
        ),
      runTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const turn = lazyStartRuntimeTurn(async () => runtime, turnInput);

    await expect(turn.promptSubmission).resolves.toBe("unknown");
    await expect(turn.result).resolves.toEqual({ status: "completed" });
  });

  it("reports lazy runtime startup failures as not submitted", async () => {
    const turn = lazyStartRuntimeTurn(async () => {
      throw new Error("runtime unavailable");
    }, turnInput);

    await expect(turn.promptSubmission).resolves.toBe("not_submitted");
    await expect(turn.result).rejects.toThrow("runtime unavailable");
  });

  it("normalizes submission authority observer failures to unknown", async () => {
    const turn = lazyStartRuntimeTurn(
      async () => ({
        ensureSession: vi.fn(),
        startTurn: (input) => ({
          requestId: input.requestId,
          promptSubmission: Promise.reject(new Error("observer failed")),
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const }),
          cancel: vi.fn(async () => {}),
          closeStream: vi.fn(async () => {}),
        }),
        runTurn: vi.fn(),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
      turnInput,
    );

    await expect(turn.promptSubmission).resolves.toBe("unknown");
    await expect(turn.result).resolves.toEqual({ status: "completed" });
  });

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
