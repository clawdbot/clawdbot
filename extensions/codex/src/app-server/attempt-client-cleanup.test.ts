// Codex tests cover attempt client cleanup plugin behavior.
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
  unsubscribeCodexThreadBestEffort,
  terminateCodexBackgroundTerminals,
} from "./attempt-client-cleanup.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

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

  it.each([
    { name: "before native activation", startBeforeError: false, releaseRoute: false },
    { name: "after native activation", startBeforeError: true, releaseRoute: false },
    { name: "after subscription release", startBeforeError: false, releaseRoute: true },
  ])(
    "cancels an acknowledged turn when activation races an early interrupt ($name)",
    async ({ startBeforeError, releaseRoute }) => {
      const harness = createClientHarness();
      try {
        const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
          threadId: "thread-1",
          onNotification: vi.fn(),
        });
        const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
          threadId: "thread-1",
          turnId: "turn-1",
          timeoutMs: 1_000,
        });
        const settled = vi.fn();
        void completion.then(settled);
        const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
        const start = {
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
        };
        if (startBeforeError) {
          harness.send(start);
        }
        harness.send({
          id: first.id,
          error: { code: -32_600, message: "no active turn to interrupt" },
        });
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        if (releaseRoute) {
          route.release();
        }

        harness.send({
          method: "turn/started",
          params: { threadId: "peer-thread", turn: { id: "peer-turn", status: "inProgress" } },
        });
        await setImmediate();
        expect(harness.writes).toHaveLength(startBeforeError ? 2 : 1);
        if (!startBeforeError) {
          harness.send(start);
        }
        await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
        const second = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
        expect(second).toMatchObject({
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        });
        harness.send({ id: second.id, result: {} });
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        harness.send({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
        });
        await expect(completion).resolves.toBe(true);
        expect(harness.client.getCloseError()).toBeUndefined();
      } finally {
        harness.client.close();
      }
    },
  );

  it("keeps one deadline through activation and terminal confirmation", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    const request = vi.spyOn(harness.client, "request");
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const settled = vi.fn();
      void completion.then(settled);
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      await vi.advanceTimersByTimeAsync(60);
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.writes).toHaveLength(2);
      const rpcRejected = vi.fn();
      void Promise.resolve(request.mock.results.at(-1)?.value).catch(rpcRejected);
      await vi.advanceTimersByTimeAsync(39);
      expect(settled).not.toHaveBeenCalled();
      expect(rpcRejected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith(false);
      expect(rpcRejected).toHaveBeenCalledOnce();
      await expect(completion).resolves.toBe(false);
      expect(harness.client.getCloseError()).toBeUndefined();
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it.each(["no active turn to interrupt", "expected active turn id turn-1 but found turn-2"])(
    "preserves a terminal receipt that precedes an interrupt rejection: %s",
    async (message) => {
      const harness = createClientHarness();
      try {
        const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
          threadId: "thread-1",
          turnId: "turn-1",
          timeoutMs: 100,
        });
        const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
        harness.send({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
        });
        harness.send({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
        harness.send({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
        });
        harness.send({ id: first.id, error: { code: -32_600, message } });
        await expect(completion).resolves.toBe(true);
        expect(harness.writes).toHaveLength(1);
        expect(harness.client.getCloseError()).toBeUndefined();
      } finally {
        harness.client.close();
      }
    },
  );

  it("does not interrupt after its deadline when timeout callbacks are delayed", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      vi.setSystemTime(Date.now() + 100);
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(completion).resolves.toBe(false);
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it("does not act on queued activation after its physical client closes", async () => {
    const harness = createClientHarness();
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      harness.client.close();
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      await expect(completion).resolves.toBe(false);
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it("uses retained bound-turn completion after a later cleanup request", async () => {
    const harness = createClientHarness();
    try {
      const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
        threadId: "thread-1",
        onNotification: vi.fn(),
      });
      route.armTurn();
      await route.bindTurn("turn-1");
      harness.send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      });
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      await expect(completion).resolves.toBe(true);
      expect(harness.writes).toHaveLength(0);
      route.release();
    } finally {
      harness.client.close();
    }
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
      name: "the absent-active error with a terminal receipt",
      error: { code: -32_600, message: "no active turn to interrupt" },
      completed: true,
    },
    {
      name: "the absent-active error without a terminal receipt",
      error: { code: -32_600, message: "no active turn to interrupt" },
      completed: false,
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
  ])("confirms $name only from native evidence", async ({ error, completed }) => {
    const harness = createClientHarness();
    const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 10,
    });
    const request = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
    harness.send({ id: request.id, error });
    if (completed) {
      harness.send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      });
    }

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
});
