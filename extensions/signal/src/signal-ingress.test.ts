// Signal durable ingress tests cover append, recovery, and tombstone dedupe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];
type SignalIngressDispatch = Parameters<typeof startSignalIngressMonitor>[0]["dispatch"];

async function startMonitor(queue: SignalIngressQueue, dispatch: SignalIngressDispatch) {
  const monitor = await startSignalIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  return { monitor, waitForIdle: monitor.waitForIdle };
}

function signalEvent(params?: {
  senderNumber?: string | null;
  senderUuid?: string;
  timestamp?: number;
  groupId?: string;
  message?: string;
  reaction?: boolean;
}): SignalSseEvent {
  const timestamp = params?.timestamp ?? 1_700_000_000_001;
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        ...(params?.senderNumber === null
          ? {}
          : { sourceNumber: params?.senderNumber ?? "+15550001111" }),
        ...(params?.senderUuid ? { sourceUuid: params.senderUuid } : {}),
        timestamp,
        dataMessage: {
          timestamp,
          ...(params?.reaction
            ? { reaction: { emoji: "👍", targetSentTimestamp: timestamp - 1 } }
            : { message: params?.message ?? "hello" }),
          ...(params?.groupId ? { groupInfo: { groupId: params.groupId } } : {}),
        },
      },
    }),
  };
}

async function withQueue<T>(
  fn: (queue: SignalIngressQueue, stateDir: string) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue, stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Signal durable ingress", () => {
  it("propagates durable append failure before dispatch scheduling", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies SignalIngressQueue;
      const dispatch = vi.fn();
      const monitor = await startSignalIngressMonitor({
        accountId: "default",
        queue: failingQueue,
        dispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      try {
        await expect(monitor.receive(signalEvent())).rejects.toBe(appendError);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers an uncompleted append with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      const interruptedDispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const interrupted = await startMonitor(queue, interruptedDispatch);
      await interrupted.monitor.receive(event);
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.monitor.stop();

      const recoveredDispatch = vi.fn().mockResolvedValue(undefined);
      const recovered = await startMonitor(queue, recoveredDispatch);
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
        expect(recoveredDispatch).toHaveBeenCalledWith(event, expect.any(Object));
      } finally {
        await recovered.monitor.stop();
      }
    });
  });

  it("keeps a completion tombstone so a duplicate cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(event);
        await started.waitForIdle();
        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("completes only when deferred dispatch adoption becomes durable", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      let adopt: (() => void | Promise<void>) | undefined;
      const dispatch = vi.fn((_event, lifecycle) => {
        adopt = lifecycle.onAdopted;
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(await queue.listClaims()).toHaveLength(1);

        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);

        expect(adopt).toBeDefined();
        await adopt?.();
        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "malformed-event",
        {
          version: 1,
          receivedAt: 1,
          event: { event: "receive", data: "{" },
        },
        { receivedAt: 1, laneKey: "direct:number:+15550001111" },
      );
      const dispatch = vi.fn();
      const started = await startMonitor(queue, dispatch);
      try {
        await started.waitForIdle();
        expect((await queue.enqueue("malformed-event", {} as SignalIngressPayload)).kind).toBe(
          "failed",
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("dedupes a concrete Signal redelivery by sender and timestamp", async () => {
    await withQueue(async (queue) => {
      const original = signalEvent({
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        timestamp: 1_700_000_000_099,
        message: "redelivered message",
      });
      const redelivery = signalEvent({
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        timestamp: 1_700_000_000_099,
        message: "redelivered message",
      });
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(original);
        await started.waitForIdle();
        await started.monitor.receive(redelivery);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it.each([
    { description: "direct phone-only delivery gains a UUID", phoneFirst: true },
    { description: "direct dual-identity delivery loses its UUID", phoneFirst: false },
    {
      description: "group phone-only delivery gains a UUID",
      phoneFirst: true,
      groupId: "group-123",
    },
    {
      description: "group dual-identity delivery loses its UUID",
      phoneFirst: false,
      groupId: "group-123",
    },
    {
      description: "approval reaction delivery gains a UUID",
      phoneFirst: true,
      reaction: true,
    },
    {
      description: "approval reaction delivery loses its UUID",
      phoneFirst: false,
      reaction: true,
    },
    {
      description: "group reaction delivery gains a UUID",
      phoneFirst: true,
      groupId: "group-123",
      reaction: true,
    },
    {
      description: "group reaction delivery loses its UUID",
      phoneFirst: false,
      groupId: "group-123",
      reaction: true,
    },
  ])("dedupes after restart when $description", async ({ phoneFirst, groupId, reaction }) => {
    await withQueue(async (queue) => {
      const shared = {
        senderNumber: "+15550002222",
        timestamp: 1_700_000_000_099,
        ...(groupId ? { groupId } : {}),
        ...(reaction ? { reaction } : {}),
      };
      const phoneOnly = signalEvent(shared);
      const withUuid = signalEvent({
        ...shared,
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
      });
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const initial = await startMonitor(queue, dispatch);
      await initial.monitor.receive(phoneFirst ? phoneOnly : withUuid);
      await initial.waitForIdle();
      await initial.monitor.stop();

      const restarted = await startMonitor(queue, dispatch);
      try {
        await restarted.monitor.receive(phoneFirst ? withUuid : phoneOnly);
        await restarted.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await restarted.monitor.stop();
      }
    });
  });

  it.each([
    {
      description: "phone-only",
      params: { senderNumber: "+15550002222" },
      numberAliases: 0,
    },
    {
      description: "UUID-only",
      params: {
        senderNumber: null,
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
      },
      numberAliases: 0,
    },
    {
      description: "dual-identity",
      params: {
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
      },
      numberAliases: 1,
    },
  ])("bounds completion aliases for $description senders", async ({ params, numberAliases }) => {
    await withQueue(async (queue) => {
      const complete = vi.spyOn(queue, "complete");
      const started = await startMonitor(queue, vi.fn().mockResolvedValue(undefined));
      try {
        await started.monitor.receive(signalEvent(params));
        await started.waitForIdle();
        expect(complete.mock.calls.filter(([id]) => typeof id === "string")).toHaveLength(
          numberAliases,
        );
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("keeps the original durable message when identity-alias completion fails", async () => {
    await withQueue(async (queue) => {
      const aliasError = new Error("sqlite alias unavailable");
      let failAlias = true;
      const failingQueue = {
        ...queue,
        complete: vi.fn<SignalIngressQueue["complete"]>(async (idOrClaim, options) => {
          if (typeof idOrClaim === "string" && failAlias) {
            failAlias = false;
            throw aliasError;
          }
          return await queue.complete(idOrClaim, options);
        }),
      } satisfies SignalIngressQueue;
      const withUuid = signalEvent({
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
      });
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const started = await startMonitor(failingQueue, dispatch);
      try {
        await expect(started.monitor.receive(withUuid)).rejects.toBe(aliasError);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);

        await started.monitor.receive(withUuid);
        await started.monitor.receive(signalEvent({ senderNumber: "+15550002222" }));
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("retains the prior message window when dual-identity envelopes need two tombstones", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const started = await startMonitor(queue, vi.fn().mockResolvedValue(undefined));
      try {
        await started.monitor.receive(
          signalEvent({ senderUuid: "123e4567-e89b-12d3-a456-426614174000" }),
        );
        await started.waitForIdle();
        expect(prune).toHaveBeenCalledWith(
          expect.objectContaining({
            completedMaxEntries: 2_000,
            completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
          }),
        );
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it.each([true, false])(
    "serializes concurrent sender-identity aliases when phone-only arrives first: %s",
    async (phoneFirst) => {
      await withQueue(async (queue) => {
        const phoneOnly = signalEvent({ senderNumber: "+15550002222" });
        const withUuid = signalEvent({
          senderNumber: "+15550002222",
          senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        });
        const dispatch = vi.fn().mockResolvedValue(undefined);
        const started = await startMonitor(queue, dispatch);
        try {
          await Promise.all(
            (phoneFirst ? [phoneOnly, withUuid] : [withUuid, phoneOnly]).map((event) =>
              started.monitor.receive(event),
            ),
          );
          await started.waitForIdle();
          expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
          await started.monitor.stop();
        }
      });
    },
  );

  it.each([true, false])(
    "does not double-dispatch an adopted claim when phone-only delivery comes first: %s",
    async (phoneFirst) => {
      await withQueue(async (queue) => {
        const phoneOnly = signalEvent({ senderNumber: "+15550002222" });
        const withUuid = signalEvent({
          senderNumber: "+15550002222",
          senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        });
        let adopt: (() => void | Promise<void>) | undefined;
        const dispatch = vi.fn((_event, lifecycle) => {
          adopt = lifecycle.onAdopted;
          lifecycle.onDeferred();
          return { kind: "deferred" } as const;
        });
        const started = await startMonitor(queue, dispatch);
        try {
          await started.monitor.receive(phoneFirst ? phoneOnly : withUuid);
          await started.waitForIdle();
          expect(await queue.listClaims()).toHaveLength(1);

          await started.monitor.receive(phoneFirst ? withUuid : phoneOnly);
          await started.waitForIdle();
          expect(dispatch).toHaveBeenCalledTimes(1);
          expect(await queue.listClaims()).toHaveLength(1);

          await adopt?.();
          await started.waitForIdle();
          expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
          await started.monitor.stop();
        }
      });
    },
  );

  it("keeps identity-alias tombstones scoped to their Signal account", async () => {
    await withQueue(async (queue, stateDir) => {
      const otherQueue = createChannelIngressQueueForTests<SignalIngressPayload>({
        channelId: "signal",
        accountId: "other",
        stateDir,
      });
      const firstDispatch = vi.fn().mockResolvedValue(undefined);
      const otherDispatch = vi.fn().mockResolvedValue(undefined);
      const first = await startMonitor(queue, firstDispatch);
      const other = await startSignalIngressMonitor({
        accountId: "other",
        queue: otherQueue,
        dispatch: otherDispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      try {
        await first.monitor.receive(
          signalEvent({
            senderNumber: "+15550002222",
            senderUuid: "123e4567-e89b-12d3-a456-426614174000",
          }),
        );
        await other.receive(signalEvent({ senderNumber: "+15550002222" }));
        await first.waitForIdle();
        await other.waitForIdle();
        expect(firstDispatch).toHaveBeenCalledTimes(1);
        expect(otherDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await first.monitor.stop();
        await other.stop();
      }
    });
  });

  it("uses a direct-sender or group-conversation lane and stores the raw event", async () => {
    await withQueue(async (queue) => {
      const direct = signalEvent({ senderUuid: "123e4567-e89b-12d3-a456-426614174000" });
      const group = signalEvent({ groupId: "group-123", timestamp: 1_700_000_000_002 });
      const dispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(direct);
        await started.monitor.receive(group);
        await started.waitForIdle();

        expect(await queue.listClaims()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              laneKey: "direct:uuid:123e4567-e89b-12d3-a456-426614174000",
              payload: expect.objectContaining({ event: direct }),
            }),
            expect.objectContaining({
              laneKey: "group:group-123",
              payload: expect.objectContaining({ event: group }),
            }),
          ]),
        );
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it.each([
    ["sync", { envelope: { sourceNumber: "+15550001111", timestamp: 1, syncMessage: {} } }],
    ["receipt", { envelope: { sourceNumber: "+15550001111", timestamp: 2, receiptMessage: {} } }],
    ["typing", { envelope: { sourceNumber: "+15550001111", timestamp: 3, typingMessage: {} } }],
  ])("does not journal %s envelopes", async (_label, payload) => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn();
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive({ event: "receive", data: JSON.stringify(payload) });
        await started.waitForIdle();
        await expect(queue.listPending({ limit: "all" })).resolves.toHaveLength(0);
        await expect(queue.listClaims()).resolves.toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await started.monitor.stop();
      }
    });
  });
});
