// Mattermost durable ingress tests cover append, recovery, and tombstones.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type MattermostIngressQueue = NonNullable<
  Parameters<typeof createMattermostIngressMonitor>[0]["queue"]
>;
type MattermostIngressPayload = Parameters<MattermostIngressQueue["enqueue"]>[1];
type MattermostIngressDispatch = Parameters<typeof createMattermostIngressMonitor>[0]["dispatch"];
type MattermostIngressInteractionDispatch = Parameters<
  typeof createMattermostIngressMonitor
>[0]["dispatchInteraction"];

function buttonClick(params?: { eventId?: string; channelId?: string; postId?: string }) {
  return {
    eventId: params?.eventId ?? "click-1",
    channelId: params?.channelId ?? "channel-1",
    userId: "user-1",
    userName: "alice",
    actionId: "approve",
    actionName: "Approve",
    postId: params?.postId ?? "post-1",
  };
}

function postedEvent(params?: {
  postId?: string;
  channelId?: string;
  message?: string;
  event?: "posted" | "post_edited";
}): string {
  return JSON.stringify({
    event: params?.event ?? "posted",
    data: {
      post: JSON.stringify({
        id: params?.postId ?? "post-1",
        channel_id: params?.channelId ?? "channel-1",
        user_id: "user-1",
        message: params?.message ?? "hello",
      }),
    },
  });
}

function startMonitor(
  queue: MattermostIngressQueue,
  dispatch: MattermostIngressDispatch,
  accountId = "default",
  runtime: Parameters<typeof createMattermostIngressMonitor>[0]["runtime"] = {
    error: vi.fn(),
    log: vi.fn(),
  },
  dispatchInteraction: MattermostIngressInteractionDispatch = async (_interaction, lifecycle) => {
    await lifecycle.onAdopted();
  },
) {
  return createMattermostIngressMonitor({
    accountId,
    queue,
    dispatch,
    dispatchInteraction,
    runtime,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
}

function createQueue(stateDir: string, accountId: string): MattermostIngressQueue {
  return createChannelIngressQueueForTests<MattermostIngressPayload>({
    channelId: "mattermost",
    accountId,
    stateDir,
  });
}

async function withStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-ingress-"));
  const stateDir = await fs.realpath(created);
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withQueue<T>(fn: (queue: MattermostIngressQueue) => Promise<T>): Promise<T> {
  return await withStateDir(async (stateDir) => await fn(createQueue(stateDir, "default")));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Mattermost durable ingress", () => {
  it("visibly rejects an authorless event without disconnecting subsequent ingress", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.spyOn(queue, "enqueue");
      const dispatch = vi.fn();
      const runtime = { error: vi.fn(), log: vi.fn() };
      const monitor = startMonitor(queue, dispatch, "default", runtime);
      try {
        await monitor.receive(
          JSON.stringify({
            event: "posted",
            data: {
              post: JSON.stringify({
                id: "post-missing-author",
                channel_id: "channel-1",
                message: "hello",
              }),
            },
            broadcast: { channel_id: "channel-1", user_id: "broadcast-user" },
          }),
        );
        expect(enqueue).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Mattermost posted event is missing post.user_id"),
        );

        await monitor.receive(postedEvent({ postId: "post-after-invalid" }));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("propagates durable append failure before handler scheduling", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies MattermostIngressQueue;
      const dispatch = vi.fn();
      const monitor = startMonitor(failingQueue, dispatch);
      try {
        await expect(monitor.receive(postedEvent())).rejects.toBe(appendError);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers an uncompleted post with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const interruptedDispatch = vi.fn((_post, _payload, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const interrupted = startMonitor(queue, interruptedDispatch);
      await interrupted.receive(postedEvent({ postId: "post-restart" }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDispatch = vi.fn(async (_post, _payload, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startMonitor(queue, recoveredDispatch);
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("answers a recorded button click after the process that took it is gone", async () => {
    await withQueue(async (queue) => {
      const droppedClick = vi.fn(async (_interaction, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const accepted = startMonitor(queue, vi.fn(), "default", undefined, droppedClick);
      await accepted.receiveInteraction(buttonClick({ eventId: "click-restart" }));
      await accepted.waitForIdle();
      // The click is durable, so losing this process cannot lose the press.
      expect(await queue.listClaims()).toHaveLength(1);
      await accepted.stop();

      const replayed = vi.fn(async (_interaction, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startMonitor(queue, vi.fn(), "default", undefined, replayed);
      try {
        await recovered.waitForIdle();
        expect(replayed).toHaveBeenCalledTimes(1);
        expect(replayed.mock.calls[0]?.[0]).toMatchObject({
          eventId: "click-restart",
          actionId: "approve",
          postId: "post-1",
        });
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a click in its channel's lane so it stays ordered behind that channel's posts", async () => {
    await withQueue(async (queue) => {
      const monitor = startMonitor(queue, vi.fn(), "default", undefined, async (_i, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      try {
        await monitor.receiveInteraction(
          buttonClick({ eventId: "click-lane", channelId: "channel-raw" }),
        );
        await monitor.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "click-lane",
            laneKey: "channel:channel-raw",
            payload: expect.objectContaining({
              interaction: expect.objectContaining({ actionId: "approve" }),
            }),
          }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("surfaces a failed click append so the callback is never answered with success", async () => {
    await withQueue(async (queue) => {
      vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("ingress storage unavailable"));
      const monitor = startMonitor(queue, vi.fn());
      try {
        await expect(monitor.receiveInteraction(buttonClick())).rejects.toThrow(
          "ingress storage unavailable",
        );
      } finally {
        await monitor.stop();
      }
    });
  });

  it("settles only the restarted account and recovers its durable row exactly once", async () => {
    await withStateDir(async (stateDir) => {
      const queueA = createQueue(stateDir, "account-a");
      const queueB = createQueue(stateDir, "account-b");
      const dispatchA = vi.fn<MattermostIngressDispatch>(async (_post, _payload, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const dispatchBBeforeRestart = vi.fn<MattermostIngressDispatch>(async () => undefined);
      const monitorA = startMonitor(queueA, dispatchA, "account-a");
      const monitorBBeforeRestart = startMonitor(queueB, dispatchBBeforeRestart, "account-b");
      const admissionStored = createDeferred<void>();
      const releaseAdmission = createDeferred<void>();
      const enqueueB = queueB.enqueue.bind(queueB);
      queueB.enqueue = async (...args) => {
        const result = await enqueueB(...args);
        admissionStored.resolve();
        await releaseAdmission.promise;
        return result;
      };
      let admittingB: Promise<void> | undefined;
      let stoppingB: Promise<void> | undefined;

      try {
        await Promise.all([monitorA.waitForIdle(), monitorBBeforeRestart.waitForIdle()]);
        await monitorA.receive(postedEvent({ postId: "post-account-a" }));
        await monitorA.waitForIdle();
        const claimsABefore = await queueA.listClaims();
        expect(claimsABefore).toHaveLength(1);
        expect(dispatchA).toHaveBeenCalledTimes(1);

        admittingB = monitorBBeforeRestart.receive(postedEvent({ postId: "post-account-b" }));
        await admissionStored.promise;
        let stopSettled = false;
        stoppingB = monitorBBeforeRestart.stop().then(() => {
          stopSettled = true;
        });
        await Promise.resolve();

        // stop() must wait for the serialized append admission. Account A's
        // drain claim and debounce handoff stay owned by its live monitor.
        expect(stopSettled).toBe(false);
        expect(await queueA.listClaims()).toEqual(claimsABefore);
        expect(dispatchA).toHaveBeenCalledTimes(1);

        releaseAdmission.resolve();
        await Promise.all([admittingB, stoppingB]);
        expect(dispatchBBeforeRestart).not.toHaveBeenCalled();
        expect(await queueB.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({ id: "post-account-b" }),
        ]);
        expect(await queueA.listClaims()).toEqual(claimsABefore);

        const dispatchBAfterRestart = vi.fn<MattermostIngressDispatch>(
          async (_post, _payload, lifecycle) => {
            await lifecycle.onAdopted();
          },
        );
        const monitorBAfterRestart = startMonitor(queueB, dispatchBAfterRestart, "account-b");
        try {
          await monitorBAfterRestart.waitForIdle();
          expect(dispatchBAfterRestart).toHaveBeenCalledTimes(1);
          expect(dispatchBAfterRestart.mock.calls[0]?.[0].id).toBe("post-account-b");

          await monitorBAfterRestart.receive(postedEvent({ postId: "post-account-b" }));
          await monitorBAfterRestart.waitForIdle();
          expect(dispatchBAfterRestart).toHaveBeenCalledTimes(1);
          expect(await queueA.listClaims()).toEqual(claimsABefore);
          expect(dispatchA).toHaveBeenCalledTimes(1);
        } finally {
          await monitorBAfterRestart.stop();
        }
      } finally {
        releaseAdmission.resolve();
        await Promise.allSettled(
          [admittingB, stoppingB].filter((task): task is Promise<void> => task !== undefined),
        );
        await Promise.allSettled([monitorA.stop(), monitorBBeforeRestart.stop()]);
      }
    });
  });

  it("retains completion so a duplicate post id cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_post, _payload, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        const event = postedEvent({ postId: "post-completed" });
        await monitor.receive(event);
        await monitor.waitForIdle();
        await monitor.receive(event);
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("preserves every id from the retired merged-message guard key space", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_post, _payload, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(postedEvent({ postId: "post-batch-first", message: "first" }));
        await monitor.receive(postedEvent({ postId: "post-batch-second", message: "second" }));
        await monitor.waitForIdle();

        await monitor.receive(postedEvent({ postId: "post-batch-first", message: "first" }));
        await monitor.waitForIdle();

        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch.mock.calls.map(([post]) => post.id)).toEqual([
          "post-batch-first",
          "post-batch-second",
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("stores the exact raw envelope in a per-channel lane", async () => {
    await withQueue(async (queue) => {
      const rawEvent = postedEvent({ postId: "post-raw", channelId: "channel-raw" });
      const dispatch = vi.fn((_post, _payload, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(rawEvent);
        await monitor.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "post-raw",
            laneKey: "channel:channel-raw",
            payload: expect.objectContaining({ rawEvent }),
          }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not let ignored post_edited events tombstone a later posted event", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_post, _payload, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(postedEvent({ postId: "post-edit", event: "post_edited" }));
        await monitor.waitForIdle();
        await monitor.receive(postedEvent({ postId: "post-edit", event: "posted" }));
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("preserves same-channel arrival order across an append retry backoff", async () => {
    await withQueue(async (queue) => {
      let failFirst = true;
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("sqlite busy");
        }
        return await enqueue(...args);
      };
      const dispatched: string[] = [];
      const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
        dispatched.push(post.id);
        await lifecycle.onAdopted();
      });
      try {
        // A's first append fails into backoff; B arrives concurrently. The
        // admission chain must hold B until A commits, or lane order inverts.
        const admitA = ingress.receive(postedEvent({ postId: "post-A" }));
        const admitB = ingress.receive(postedEvent({ postId: "post-B" }));
        await Promise.all([admitA, admitB]);
        await vi.waitFor(() => expect(dispatched).toEqual(["post-A", "post-B"]), {
          timeout: 5_000,
        });
      } finally {
        await ingress.stop();
      }
    });
  });

  it("never dispatches from a pump racing stop through the async prune", async () => {
    await withQueue(async (queue) => {
      let releasePrune = () => {};
      const pruneGate = new Promise<void>((resolve) => {
        releasePrune = resolve;
      });
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        await pruneGate;
        return await prune(...args);
      };
      const dispatch = vi.fn();
      const ingress = startMonitor(queue, dispatch);
      await ingress.receive(postedEvent({ postId: "post-stop-race" }));

      const stopping = ingress.stop();
      releasePrune();
      await stopping;

      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("retries a transient append failure and escalates a persistent one", async () => {
    await withQueue(async (queue) => {
      let failures = 2;
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("sqlite busy");
        }
        return await enqueue(...args);
      };
      const dispatch = vi.fn();
      const ingress = startMonitor(queue, dispatch);
      try {
        // Two transient failures absorb into the bounded retry.
        await ingress.receive(postedEvent({ postId: "post-retry" }));
        await ingress.waitForIdle();
        expect(failures).toBe(0);
        expect(dispatch).toHaveBeenCalledOnce();

        // A persistent failure escalates so the websocket can tear down loudly.
        failures = Number.POSITIVE_INFINITY;
        await expect(ingress.receive(postedEvent({ postId: "post-lost" }))).rejects.toThrow(
          "sqlite busy",
        );
      } finally {
        await ingress.stop();
      }
    });
  });

  it("accepts a post whose channel id arrives at the envelope level", async () => {
    await withQueue(async (queue) => {
      const dispatched: string[] = [];
      const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
        dispatched.push(post.id);
        await lifecycle.onAdopted();
      });
      try {
        // The monitor dispatch honors post/data/broadcast channel ids; the
        // durable inspector must not reject the envelope-level shapes.
        await ingress.receive(
          JSON.stringify({
            event: "posted",
            data: {
              channel_id: "channel-envelope",
              post: JSON.stringify({ id: "post-envelope", user_id: "user-1", message: "hi" }),
            },
          }),
        );
        await vi.waitFor(() => expect(dispatched).toEqual(["post-envelope"]));
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "post-malformed",
        { version: 1, receivedAt: 1, rawEvent: "{" },
        { receivedAt: 1, laneKey: "channel:channel-1" },
      );
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.waitForIdle();
        expect((await queue.enqueue("post-malformed", {} as MattermostIngressPayload)).kind).toBe(
          "failed",
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters a stored row of an unrecognized shape without retry", async () => {
    // A reader must treat a row it cannot name as permanently bad, not as work to
    // retry. That is what keeps one unreadable row from holding up the lane's
    // posts behind it, and it is the property a downgrade relies on when it meets
    // a row a newer process wrote.
    await withQueue(async (queue) => {
      await queue.enqueue(
        "row-unknown-shape",
        { version: 1, receivedAt: 1 } as MattermostIngressPayload,
        { receivedAt: 1, laneKey: "channel:channel-1" },
      );
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.waitForIdle();
        expect(
          (await queue.enqueue("row-unknown-shape", {} as MattermostIngressPayload)).kind,
        ).toBe("failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters a persisted authorless post without using broadcast recipient identity", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "post-missing-author",
        {
          version: 1,
          receivedAt: 1,
          rawEvent: JSON.stringify({
            event: "posted",
            data: {
              post: JSON.stringify({
                id: "post-missing-author",
                channel_id: "channel-1",
                message: "hello",
              }),
            },
            broadcast: { channel_id: "channel-1", user_id: "broadcast-user" },
          }),
        },
        { receivedAt: 1, laneKey: "channel:channel-1" },
      );
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.waitForIdle();
        expect(
          (await queue.enqueue("post-missing-author", {} as MattermostIngressPayload)).kind,
        ).toBe("failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters permanent Mattermost auth failures", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new Error("Mattermost API 401 Unauthorized: invalid token");
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(postedEvent({ postId: "post-auth" }));
        await monitor.waitForIdle();
        expect((await queue.enqueue("post-auth", {} as MattermostIngressPayload)).kind).toBe(
          "failed",
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("leaves transient Mattermost failures retryable", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new Error("Mattermost API 503 Service Unavailable");
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(postedEvent({ postId: "post-transient" }));
        await monitor.waitForIdle();
        expect(await queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({ id: "post-transient" }),
        ]);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });
});
