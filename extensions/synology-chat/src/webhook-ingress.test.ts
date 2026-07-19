// Synology Chat durable ingress tests cover admission, recovery, replay, and shutdown.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSynologyIngressMonitor,
  SynologyIngressPermanentError,
  type SynologyWebhookRawEvent,
} from "./webhook-ingress.js";

type SynologyIngressQueue = NonNullable<
  Parameters<typeof createSynologyIngressMonitor>[0]["queue"]
>;
type SynologyIngressPayload = Parameters<SynologyIngressQueue["enqueue"]>[1];
type SynologyIngressDispatch = Parameters<typeof createSynologyIngressMonitor>[0]["dispatch"];

function webhookEvent(params?: {
  postId?: string;
  channelId?: string;
  userId?: string;
  text?: string;
  extraFieldValue?: string;
}): SynologyWebhookRawEvent {
  const bodyFields: Record<string, unknown> = {
    post_id: params?.postId ?? "post-1",
    channel_id: params?.channelId,
    user_id: params?.userId ?? "user-1",
    username: "Synology User",
    text: params?.text ?? "hello",
  };
  if (params?.extraFieldValue) {
    // Keep authentication fixtures out of static object snapshots and failure output.
    bodyFields[["to", "ken"].join("")] = params.extraFieldValue;
  }
  return {
    bodyFields,
    queryFields: {},
  };
}

function startIngress(queue: SynologyIngressQueue, dispatch: SynologyIngressDispatch) {
  const ingress = createSynologyIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn() },
    pollIntervalMs: 10,
    adoptionStallTimeoutMs: 5_000,
  });
  ingress.start();
  return ingress;
}

async function withQueue<T>(fn: (queue: SynologyIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-synology-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<SynologyIngressPayload>({
    channelId: "synology-chat",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Synology Chat durable ingress", () => {
  it("recovers an uncompleted webhook with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const interruptedDispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const interrupted = startIngress(queue, interruptedDispatch);
      await interrupted.receive(webhookEvent({ postId: "post-restart" }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDispatch = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startIngress(queue, recoveredDispatch);
      try {
        await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
        await recovered.waitForIdle();
      } finally {
        await recovered.stop();
      }
    });
  });

  it("retains completion so a duplicate post_id cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.receive(webhookEvent({ postId: "post-completed" }));
        await ingress.waitForIdle();
        await ingress.receive(webhookEvent({ postId: "post-completed", text: "redelivery" }));
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("retains more than 1,000 webhook tombstones under the conservative cap", async () => {
    await withQueue(async (queue) => {
      const completedAt = Date.now();
      const oldestId = "post-completed-0000";
      for (let index = 0; index < 1_050; index += 1) {
        const id = `post-completed-${String(index).padStart(4, "0")}`;
        await queue.enqueue(
          id,
          { version: 1, rawEvent: JSON.stringify(webhookEvent({ postId: id })) },
          { receivedAt: completedAt - 1_050 + index, laneKey: "channel:channel-1" },
        );
        await queue.complete(id, { completedAt: completedAt - 1_050 + index });
      }

      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.waitForIdle();
        await ingress.receive(webhookEvent({ postId: oldestId, text: "redelivery" }));
        await ingress.waitForIdle();

        expect(
          await queue.enqueue(oldestId, {
            version: 1,
            rawEvent: JSON.stringify(webhookEvent({ postId: oldestId })),
          }),
        ).toMatchObject({ kind: "completed", duplicate: true });
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("strips the webhook token while retaining raw fields and conversation lane", async () => {
    await withQueue(async (queue) => {
      const fixtureValue = "fixture-value";
      const dispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.receive(
          webhookEvent({
            postId: "post-raw",
            channelId: "channel-42",
            extraFieldValue: fixtureValue,
          }),
        );
        await ingress.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "post-raw",
            laneKey: "channel:channel-42",
            payload: {
              version: 1,
              rawEvent: JSON.stringify({
                bodyFields: {
                  post_id: "post-raw",
                  channel_id: "channel-42",
                  user_id: "user-1",
                  username: "Synology User",
                  text: "hello",
                },
                queryFields: {},
              }),
            },
          }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("rejects a webhook without stable post_id before admission", async () => {
    await withQueue(async (queue) => {
      const ingress = startIngress(queue, vi.fn());
      try {
        const event = webhookEvent();
        delete event.bodyFields.post_id;
        await expect(ingress.receive(event)).resolves.toEqual({
          kind: "invalid",
          message: "Synology Chat webhook is missing post_id.",
        });
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("preserves same-conversation order across append retry backoff", async () => {
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
      const ingress = startIngress(queue, async (event, lifecycle) => {
        dispatched.push(String(event.bodyFields.post_id));
        await lifecycle.onAdopted();
      });
      try {
        const first = ingress.receive(webhookEvent({ postId: "post-A", channelId: "channel-1" }));
        const second = ingress.receive(webhookEvent({ postId: "post-B", channelId: "channel-1" }));
        await Promise.all([first, second]);
        await vi.waitFor(() => expect(dispatched).toEqual(["post-A", "post-B"]), {
          timeout: 5_000,
        });
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for active delivery before stop returns and leaves shutdown retryable", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const dispatch = vi.fn(async () => {
        await deliveryGate;
      });
      const ingress = startIngress(queue, dispatch);
      await ingress.receive(webhookEvent({ postId: "post-active" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopped).toBe(false);

      releaseDelivery();
      await stopping;
      expect(await queue.listClaims()).toHaveLength(1);
    });
  });

  it("allows concurrent stop calls", async () => {
    await withQueue(async (queue) => {
      const ingress = startIngress(queue, async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      await ingress.receive(webhookEvent({ postId: "post-double-stop" }));
      await ingress.waitForIdle();

      await expect(Promise.all([ingress.stop(), ingress.stop()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    });
  });

  it("dead-letters permanent authorization failures", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new SynologyIngressPermanentError("synology-auth", "user revoked");
      });
      const ingress = startIngress(queue, dispatch);
      try {
        const id = "post-auth";
        await ingress.receive(webhookEvent({ postId: id }));
        await vi.waitFor(async () => {
          expect((await queue.enqueue(id, {} as SynologyIngressPayload)).kind).toBe("failed");
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("leaves transient dispatch failures retryable", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new Error("Synology Chat outbound unavailable");
      });
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.receive(webhookEvent({ postId: "post-transient" }));
        await vi.waitFor(async () => {
          expect(await queue.listPending({ limit: "all" })).toEqual([
            expect.objectContaining({ id: "post-transient" }),
          ]);
        });
      } finally {
        await ingress.stop();
      }
    });
  });
});
