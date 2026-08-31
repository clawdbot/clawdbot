// Codex tests cover attempt client cleanup plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  unsubscribeCodexThreadBestEffort,
  terminateCodexBackgroundTerminals,
} from "./attempt-client-cleanup.js";
import { createClientHarness } from "./test-support.js";

describe("Codex app-server attempt client cleanup", () => {
  it.each([true, false])(
    "drains the full terminal inventory and accepts a concurrent exit (%s)",
    async (terminated) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ processId: "10" }, { processId: "20" }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({ terminated })
        .mockResolvedValueOnce({ terminated: true })
        .mockResolvedValueOnce({ data: [], nextCursor: null });
      await expect(
        terminateCodexBackgroundTerminals({ request } as never, "thread-1"),
      ).resolves.toBeUndefined();
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["thread/backgroundTerminals/list", { threadId: "thread-1" }],
        ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "10" }],
        ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "20" }],
        ["thread/backgroundTerminals/list", { threadId: "thread-1", limit: 1 }],
      ]);
    },
  );

  it("reports a terminal that remains running after termination", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ processId: "10" }], nextCursor: null })
      .mockResolvedValueOnce({ terminated: false })
      .mockResolvedValueOnce({ data: [{ processId: "10" }], nextCursor: null });
    await expect(
      terminateCodexBackgroundTerminals({ request } as never, "thread-1"),
    ).rejects.toThrow("Codex background-terminal cleanup failed");
  });

  it("bounds the entire terminal inventory request without closing the shared client", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    const close = vi.spyOn(harness.client, "close");
    try {
      const cleanup = terminateCodexBackgroundTerminals(harness.client, "thread-1");
      const rejected = expect(cleanup).rejects.toThrow("Codex background-terminal cleanup failed");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(close).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it("keeps strict startup retirement failures visible to lifecycle owners", async () => {
    const closeAndWait = vi.fn(async () => {
      throw new Error("strict client retirement failed");
    });

    await expect(closeCodexStartupClientBestEffort({ closeAndWait } as never)).rejects.toThrow(
      "strict client retirement failed",
    );
  });

  it("preserves the primary failure when unsafe turn retirement rejects", async () => {
    const close = vi.fn();
    const closeAndWait = vi.fn(async () => {
      throw new Error("unsafe client retirement failed");
    });

    await expect(
      retireUnsafeCodexTurnClientBestEffort({ close, closeAndWait } as never, "startup interrupt"),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for the matching terminal after an interrupt is acknowledged", async () => {
    const harness = createClientHarness();
    const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
    });
    const settled = vi.fn();
    void completion.then(settled);
    const request = JSON.parse(harness.writes.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };

    expect(request).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    harness.send({ id: request.id, result: {} });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-other", status: "interrupted" },
      },
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted" },
      },
    });

    await expect(completion).resolves.toBe(true);
    harness.client.close();
  });

  it("retains the startup interrupt acknowledgement contract", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      interruptCodexTurnAndWaitBestEffort({ request } as never, {
        threadId: "thread-1",
        turnId: "",
        timeoutMs: 123,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "" },
      { timeoutMs: 123 },
    );
  });

  it("fails closed when acknowledged interruption never reaches its terminal", async () => {
    const harness = createClientHarness();
    const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 10,
    });
    const request = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
    harness.send({ id: request.id, result: {} });

    await expect(completion).resolves.toBe(false);
    harness.client.close();
  });

  it.each([
    {
      name: "the exact already-terminal error",
      error: { code: -32_600, message: "no active turn to interrupt" },
      completed: true,
    },
    {
      name: "another invalid-request error",
      error: { code: -32_600, message: "expected another active turn" },
      completed: false,
    },
    {
      name: "the terminal message with another error code",
      error: { code: -32_000, message: "no active turn to interrupt" },
      completed: false,
    },
  ])("classifies $name without waiting for a dropped terminal", async ({ error, completed }) => {
    const harness = createClientHarness();
    const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
    });
    const request = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
    harness.send({ id: request.id, error });

    await expect(completion).resolves.toBe(completed);
    harness.client.close();
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
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const request = vi.fn(async (method: string) => {
      if (method === "turn/interrupt") {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "interrupted" },
              },
            });
          }
        });
      }
      return {};
    });
    const close = vi.fn();

    await retireCodexAppServerClientAfterTimedOutTurn(
      {
        request,
        close,
        addNotificationHandler: (handler: (notification: unknown) => void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        reason: "turn_terminal_idle_timeout",
        suspectPhysicalClient: true,
      },
    );

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
