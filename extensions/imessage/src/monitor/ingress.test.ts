// iMessage durable ingress tests cover append, recovery, adoption, and GUID tombstones.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildIMessageFlushIngressLifecycle,
  createIMessageDurableIngress,
  type IMessageIngressLifecycle,
} from "./ingress.js";

type IMessageIngressQueue = NonNullable<
  Parameters<typeof createIMessageDurableIngress>[0]["queue"]
>;
type IMessageIngressPayload = Parameters<IMessageIngressQueue["enqueue"]>[1];

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      id: 101,
      guid: "GUID-101",
      chat_id: 42,
      sender: "+15550001111",
      text: "hello",
      created_at: "2026-07-17T10:00:00.000Z",
      is_from_me: false,
      ...overrides,
    },
  };
}

function createQueue(stateDir: string): IMessageIngressQueue {
  return createChannelIngressQueueForTests<IMessageIngressPayload>({
    channelId: "imessage",
    accountId: "default",
    stateDir,
  });
}

async function withQueue<T>(
  run: (queue: IMessageIngressQueue, stateDir: string) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-ingress-"));
  const stateDir = await fs.realpath(created);
  try {
    return await run(createQueue(stateDir), stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function runtime() {
  return { error: vi.fn(), log: vi.fn() };
}

function lifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  } satisfies IMessageIngressLifecycle;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("iMessage durable ingress", () => {
  it("does not advance the read cursor or dispatch when durable append fails", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies IMessageIngressQueue;
      const dispatch = vi.fn();
      const onDurableEnqueue = vi.fn();
      const onDurableEnqueueFailure = vi.fn();
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue: failingQueue,
        dispatch,
        runtime: runtime(),
        onDurableEnqueue,
        onDurableEnqueueFailure,
      });

      try {
        await expect(ingress.receive(rawRow())).rejects.toBe(appendError);
        expect(onDurableEnqueue).not.toHaveBeenCalled();
        expect(onDurableEnqueueFailure).toHaveBeenCalledWith(101, appendError);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("notifies the source when inspection fails before durable append", async () => {
    await withQueue(async (queue) => {
      const onDurableEnqueueFailure = vi.fn();
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: runtime(),
        onDurableEnqueueFailure,
      });

      try {
        await expect(ingress.receive(rawRow({ guid: undefined }))).rejects.toThrow(
          "missing its stable GUID",
        );
        expect(onDurableEnqueueFailure).toHaveBeenCalledWith(101, expect.any(Error));
        expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("serializes durable cursor advancement before admitting the next row", async () => {
    await withQueue(async (queue) => {
      const cursorGate = deferred();
      const cursorStarted = deferred();
      let currentTime = 1_000;
      const onDurableEnqueue = vi.fn(async () => {
        cursorStarted.resolve();
        await cursorGate.promise;
      });
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: runtime(),
        onDurableEnqueue,
        now: () => currentTime,
      });

      try {
        const first = ingress.receive(rawRow());
        await cursorStarted.promise;
        currentTime = 2_000;
        const second = ingress.receive(rawRow({ id: 102, guid: "GUID-102" }));
        await Promise.resolve();

        expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
          "GUID-101",
        ]);
        currentTime = 9_000;
        cursorGate.resolve();
        await Promise.all([first, second]);
        expect(onDurableEnqueue).toHaveBeenCalledTimes(2);
        expect(
          (await queue.listPending({ limit: "all" })).map((record) => record.payload.receivedAt),
        ).toEqual([1_000, 2_000]);
      } finally {
        cursorGate.resolve();
        await ingress.stop();
      }
    });
  });

  it("recovers a durable row with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue, stateDir) => {
      const event = rawRow();
      const interrupted = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: runtime(),
      });
      await interrupted.receive(event);
      await interrupted.stop();

      closeOpenClawStateDatabaseForTest();
      const recoveredDispatch = vi.fn(async (_message, claimLifecycle) => {
        await claimLifecycle.onAdopted();
        return { kind: "deferred" } as const;
      });
      const recovered = createIMessageDurableIngress({
        accountId: "default",
        queue: createQueue(stateDir),
        dispatch: recoveredDispatch,
        runtime: runtime(),
      });
      recovered.start();
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
        expect(recoveredDispatch.mock.calls[0]?.[0]).toMatchObject({
          id: 101,
          guid: "GUID-101",
          chat_id: 42,
        });
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone so a duplicate cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_message, claimLifecycle) => {
        await claimLifecycle.onAdopted();
        return { kind: "deferred" } as const;
      });
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch,
        runtime: runtime(),
      });
      ingress.start();
      try {
        await ingress.receive(rawRow());
        await ingress.waitForIdle();
        await ingress.receive(rawRow());
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("preserves the retired guard's GUID parity across ROWID churn", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_message, claimLifecycle) => {
        await claimLifecycle.onAdopted();
        return { kind: "deferred" } as const;
      });
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch,
        runtime: runtime(),
      });
      ingress.start();
      try {
        await ingress.receive(rawRow());
        await ingress.waitForIdle();
        await ingress.receive(rawRow({ id: 999 }));
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores the raw row under its GUID in the per-chat lane", async () => {
    await withQueue(async (queue) => {
      const event = rawRow({ text: "\u0005hello" });
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: runtime(),
      });
      try {
        await ingress.receive(event);
        expect(await queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({
            id: "GUID-101",
            laneKey: "chat:42",
            payload: expect.objectContaining({ raw: event }),
          }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("carries catchup provenance through the journal to dispatch", async () => {
    await withQueue(async (queue) => {
      const provenances: Array<{ catchup?: boolean } | undefined> = [];
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(async (_message, claimLifecycle, _receivedAt, provenance) => {
          provenances.push(provenance);
          await claimLifecycle.onAdopted();
        }),
        runtime: runtime(),
      });
      try {
        ingress.start();
        // Catchup rows must reach dispatch flagged: the monitor skips the live
        // Push-flush age fence for them, or operator-requested history older
        // than the live threshold would be suppressed AND tombstoned.
        await ingress.receive(rawRow({ guid: "GUID-CATCHUP", id: 900 }), { catchup: true });
        await ingress.receive(rawRow({ guid: "GUID-LIVE", id: 901 }));
        await vi.waitFor(() => expect(provenances).toHaveLength(2));
        expect(provenances[0]).toEqual({ catchup: true });
        expect(provenances[1]).toEqual({});
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "GUID-bad",
        {
          version: 1,
          receivedAt: Date.now(),
          raw: rawRow({ guid: "GUID-bad", text: 123 }),
        },
        { laneKey: "chat:42" },
      );
      const dispatch = vi.fn();
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch,
        runtime: runtime(),
      });
      ingress.start();
      try {
        await ingress.waitForIdle();
        expect((await queue.enqueue("GUID-bad", {} as IMessageIngressPayload)).kind).toBe("failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters a persisted row whose inspected identity is malformed", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "GUID-missing",
        {
          version: 1,
          receivedAt: Date.now(),
          raw: rawRow({ guid: undefined }),
        },
        { laneKey: "chat:42" },
      );
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: runtime(),
      });
      ingress.start();
      try {
        await ingress.waitForIdle();
        expect((await queue.enqueue("GUID-missing", {} as IMessageIngressPayload)).kind).toBe(
          "failed",
        );
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters permanent Full Disk Access failures", async () => {
    await withQueue(async (queue) => {
      const ingress = createIMessageDurableIngress({
        accountId: "default",
        queue,
        dispatch: vi.fn(async () => {
          throw new Error("Full Disk Access denied for Messages chat.db");
        }),
        runtime: runtime(),
      });
      ingress.start();
      try {
        await ingress.receive(rawRow());
        await ingress.waitForIdle();
        expect((await queue.enqueue("GUID-101", {} as IMessageIngressPayload)).kind).toBe("failed");
      } finally {
        await ingress.stop();
      }
    });
  });

  it("fans merged adoption to every constituent claim", async () => {
    const first = lifecycle();
    const second = lifecycle();
    const merged = buildIMessageFlushIngressLifecycle([first, second]);

    await merged.lifecycle?.onAdopted();

    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("completes every constituent claim when a flush has no dispatch", async () => {
    const first = lifecycle();
    const second = lifecycle();
    const merged = buildIMessageFlushIngressLifecycle([first, second]);

    await merged.settle();

    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });
});
