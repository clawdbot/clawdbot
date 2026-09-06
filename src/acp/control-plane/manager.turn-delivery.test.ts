import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager turn delivery", () => {
  installAcpSessionManagerTestLifecycle();

  function setupRuntime() {
    const runtimeState = createRuntime();
    const sessionKey = "agent:codex:acp:delivery";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    });
    return { runtimeState, sessionKey, manager: new AcpSessionManager() };
  }

  it.each(["completed", "cancelled", "failed"] as const)(
    "preserves queued output behind slow delivery when the backend has %s",
    async (terminalStatus) => {
      vi.useFakeTimers();
      const { runtimeState, sessionKey, manager } = setupRuntime();
      const deliveryStarted = createDeferred();
      const releaseDelivery = createDeferred();
      const result = createDeferred<AcpRuntimeTurnResult>();
      const events: AcpRuntimeEvent[] = [];
      let streamClosed = false;
      runtimeState.runtime.startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {
          yield { type: "tool_call" as const, text: "Reading the result" };
          // ACPX closes its queue on completion; closeStream discards queued events.
          if (!streamClosed) {
            yield { type: "text_delta" as const, text: "Final deliverable" };
          }
        })(),
        result: result.promise,
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {
          streamClosed = true;
        }),
      }));
      const turn = manager
        .runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey,
          text: "Produce a deliverable",
          mode: "prompt",
          requestId: `slow-delivery-${terminalStatus}`,
          onEvent: async (event) => {
            events.push(event);
            if (event.type === "tool_call") {
              deliveryStarted.resolve();
              await releaseDelivery.promise;
            }
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      try {
        await deliveryStarted.promise;
        result.resolve(
          terminalStatus === "failed"
            ? { status: "failed", error: { message: "Backend failed after output" } }
            : { status: terminalStatus },
        );
        await vi.advanceTimersByTimeAsync(1);
        releaseDelivery.resolve();
        const error = await turn;

        expect(events.map((event) => event.type)).toEqual([
          "tool_call",
          "text_delta",
          terminalStatus === "failed" ? "error" : "done",
        ]);
        if (terminalStatus === "failed") {
          expect(error).toMatchObject({ message: "Backend failed after output" });
        } else {
          expect(error).toBeUndefined();
        }
      } finally {
        result.resolve({ status: "cancelled" });
        releaseDelivery.resolve();
        await turn;
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "cancels failed event delivery and waits for cleanup before starting queued work (prompt submitted: %s)",
    async (promptSubmitted) => {
      vi.useFakeTimers();
      const { runtimeState, sessionKey, manager } = setupRuntime();
      const deliveryStarted = createDeferred();
      const promptStarted = createDeferred();
      const result = createDeferred<AcpRuntimeTurnResult>();
      const cancel = vi.fn(async () => {});
      const deliveryError = new Error("Channel delivery failed");
      const starts: string[] = [];
      runtimeState.runtime.startTurn = vi.fn((input) => {
        starts.push(input.requestId);
        return {
          requestId: input.requestId,
          promptStarted:
            input.requestId === "first" && !promptSubmitted
              ? promptStarted.promise
              : Promise.resolve(),
          events: (async function* () {
            if (input.requestId === "first") {
              yield { type: "status" as const, text: "Session resumed" };
            }
          })(),
          result:
            input.requestId === "first"
              ? result.promise
              : Promise.resolve({ status: "completed" as const }),
          cancel,
          closeStream: vi.fn(async () => {}),
        };
      });
      const input = {
        provenance: "system" as const,
        cfg: baseCfg,
        sessionKey,
        text: "Do work",
        mode: "prompt" as const,
      };
      const first = manager
        .runTurn({
          ...input,
          requestId: "first",
          onEvent: () => {
            deliveryStarted.resolve();
            throw deliveryError;
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let second: Promise<void> | undefined;

      try {
        await deliveryStarted.promise;
        second = manager.runTurn({ ...input, requestId: "second" });
        await vi.advanceTimersByTimeAsync(1);

        expect(cancel).toHaveBeenCalledOnce();
        expect(starts).toEqual(["first"]);
        result.resolve({ status: "cancelled" });
        expect(await first).toMatchObject({ message: deliveryError.message });
        await second;
        expect(starts).toEqual(["first", "second"]);
      } finally {
        result.resolve({ status: "cancelled" });
        promptStarted.resolve();
        await first;
        await second;
        vi.useRealTimers();
      }
    },
  );
});
