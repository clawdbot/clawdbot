// Codex tests cover attempt client cleanup plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";

describe("Codex app-server attempt client cleanup", () => {
  it("interrupts turns with optional request timeout", () => {
    const request = vi.fn(async () => ({}));

    interruptCodexTurnBestEffort({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 123,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 123 },
    );
  });

  it("swallows unsubscribe cleanup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("already gone");
    });

    await expect(
      unsubscribeCodexThreadBestEffort({ request } as never, {
        threadId: "thread-1",
        timeoutMs: 123,
      }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 123 },
    );
  });

  it("closes only the isolated client after timed-out turn cleanup", async () => {
    const request = vi.fn(async () => ({}));
    const close = vi.fn();

    await retireCodexAppServerClientAfterTimedOutTurn({ request, close } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "turn_terminal_idle_timeout",
      suspectPhysicalClient: true,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
