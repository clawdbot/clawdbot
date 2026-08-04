// IRC durable ingress tests cover append ordering, local ids, recovery, and tombstones.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrcIngressMonitor } from "./irc-ingress.js";

type IrcIngressQueue = NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
type IrcIngressPayload = Parameters<IrcIngressQueue["enqueue"]>[1];
type IrcIngressDispatch = Parameters<typeof createIrcIngressMonitor>[0]["dispatch"];

const CHANNEL_LINE = ":alice!ident@example.org PRIVMSG #room :hello";

function createQueue(stateDir: string): IrcIngressQueue {
  return createChannelIngressQueueForTests<IrcIngressPayload>({
    channelId: "irc",
    accountId: "default",
    stateDir,
  });
}

async function withQueue<T>(fn: (queue: IrcIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-irc-ingress-"));
  const stateDir = await fs.realpath(created);
  try {
    return await fn(createQueue(stateDir));
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startIngress(queue: IrcIngressQueue, dispatch: IrcIngressDispatch) {
  const ingress = createIrcIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 10,
    adoptionStallTimeoutMs: 5_000,
  });
  ingress.start();
  return ingress;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("IRC durable ingress", () => {
  it("does not dispatch when the durable append fails", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies IrcIngressQueue;
      const dispatch = vi.fn();
      const ingress = startIngress(failingQueue, dispatch);
      try {
        await expect(
          ingress.openConnection("connection-a").accept(CHANNEL_LINE, "bot"),
        ).rejects.toBe(appendError);
        expect(failingQueue.enqueue).toHaveBeenCalledTimes(3);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("recovers a durable pre-dispatch append with a fresh drain exactly once", async () => {
    await withQueue(async (queue) => {
      const interruptedDispatch = vi.fn();
      const interrupted = createIrcIngressMonitor({
        accountId: "default",
        queue,
        dispatch: interruptedDispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      await interrupted.openConnection("connection-restart").accept(CHANNEL_LINE, "receipt-bot");
      expect(await queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: "local:connection-restart:000000000001",
          laneKey: "channel:#room",
          payload: expect.objectContaining({ rawLine: CHANNEL_LINE }),
        }),
      ]);
      await interrupted.stop();
      expect(interruptedDispatch).not.toHaveBeenCalled();

      const recoveredDispatch = vi.fn<IrcIngressDispatch>(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startIngress(queue, recoveredDispatch);
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
        expect(recoveredDispatch.mock.calls[0]?.[0]).toMatchObject({
          messageId: "local:connection-restart:000000000001",
          target: "#room",
          rawTarget: "#room",
          senderNick: "alice",
          senderUser: "ident",
          senderHost: "example.org",
          text: "hello",
          isGroup: true,
        });
        expect(recoveredDispatch.mock.calls[0]?.[2]).toEqual({
          connectedNick: "receipt-bot",
          connectionEpoch: "connection-restart",
        });
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone for the same local event id", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn<IrcIngressDispatch>(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.openConnection("connection-duplicate").accept(CHANNEL_LINE, "bot");
        await ingress.waitForIdle();
        await ingress.openConnection("connection-duplicate").accept(CHANNEL_LINE, "bot");
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("assigns distinct monotonic ids to identical lines on one connection", async () => {
    await withQueue(async (queue) => {
      const messageIds: string[] = [];
      const dispatch = vi.fn<IrcIngressDispatch>(async (message, lifecycle) => {
        messageIds.push(message.messageId);
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        const connection = ingress.openConnection("connection-identical");
        await connection.accept(CHANNEL_LINE, "bot");
        await connection.accept(CHANNEL_LINE, "bot");
        await ingress.waitForIdle();
        expect(messageIds).toEqual([
          "local:connection-identical:000000000001",
          "local:connection-identical:000000000002",
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("derives the direct-message lane from the sender nick", async () => {
    await withQueue(async (queue) => {
      const ingress = createIrcIngressMonitor({
        accountId: "default",
        queue,
        dispatch: vi.fn(),
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      try {
        await ingress
          .openConnection("connection-dm")
          .accept(":Alice!ident@example.org PRIVMSG openclaw-bot :hello", "bot");
        expect(await queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({ laneKey: "direct:alice" }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for an in-flight admission before stop returns", async () => {
    await withQueue(async (queue) => {
      const admissionStored = createDeferred();
      const releaseAdmission = createDeferred();
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        const result = await enqueue(...args);
        admissionStored.resolve();
        await releaseAdmission.promise;
        return result;
      };
      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      const admitting = ingress.openConnection("connection-stop").accept(CHANNEL_LINE, "bot");
      await admissionStored.promise;

      let stopSettled = false;
      const stopping = ingress.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      releaseAdmission.resolve();
      await Promise.all([admitting, stopping]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
    });
  });

  it("quiesces an active pump while paused and resumes without charging the next event", async () => {
    await withQueue(async (queue) => {
      const dispatchStarted = createDeferred();
      const releaseDispatch = createDeferred();
      const dispatch = vi.fn<IrcIngressDispatch>(async (message, lifecycle) => {
        if (message.messageId.endsWith("000000000001")) {
          dispatchStarted.resolve();
          await releaseDispatch.promise;
        }
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        const connection = ingress.openConnection("connection-paused");
        await connection.accept(CHANNEL_LINE, "bot");
        await dispatchStarted.promise;
        let pauseSettled = false;
        const pausing = ingress.pause().then(() => {
          pauseSettled = true;
        });
        const secondAdmission = connection.accept(CHANNEL_LINE, "bot");
        await Promise.resolve();
        expect(pauseSettled).toBe(false);

        releaseDispatch.resolve();
        await Promise.all([pausing, secondAdmission]);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({
            id: "local:connection-paused:000000000002",
            attempts: 0,
          }),
        ]);

        ingress.start();
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(2);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters a malformed persisted raw line without dispatch", async () => {
    await withQueue(async (queue) => {
      const eventId = "local:connection-bad:000000000001";
      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.openConnection("connection-bad").accept("not an IRC message", "bot");
        await ingress.waitForIdle();
        expect((await queue.enqueue(eventId, {} as IrcIngressPayload)).kind).toBe("failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("does not create a drain when stop wins an async prune race", async () => {
    await withQueue(async (queue) => {
      const pruneStarted = createDeferred();
      const releasePrune = createDeferred();
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        pruneStarted.resolve();
        await releasePrune.promise;
        return await prune(...args);
      };
      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      await pruneStarted.promise;
      const stopping = ingress.stop();
      releasePrune.resolve();
      await stopping;
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
