/** Tests ACP manager cancellation of active turns and idle sessions. */
import { describe, expect, it, vi } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("preempts an active turn on cancel and returns to idle state", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let enteredRun = false;
    runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      enteredRun = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done" as const, stopReason: "cancel" };
    });

    const manager = new AcpSessionManager();
    const runPromise = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "long task",
      mode: "prompt",
      requestId: "run-1",
    });
    await vi.waitFor(
      () => {
        expect(enteredRun).toBe(true);
      },
      { interval: 1 },
    );

    await manager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "manual-cancel",
    });
    await runPromise;

    expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(runtimeState.cancel), {
      reason: "manual-cancel",
    });
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });
});
