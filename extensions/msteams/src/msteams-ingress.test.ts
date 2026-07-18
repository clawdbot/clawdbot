// Microsoft Teams tests cover durable admission, replay, taxonomy, and redelivery dedupe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsIngress } from "./msteams-ingress.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type IngressQueue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
type IngressPayload = Parameters<IngressQueue["enqueue"]>[1];
type IngressDispatch = Parameters<typeof createMSTeamsIngress>[0]["dispatch"];

function activity(params?: {
  id?: string;
  type?: string;
  name?: string;
  conversationId?: string;
  text?: string;
}): MSTeamsTurnContext["activity"] {
  return {
    id: params?.id ?? "activity-1",
    type: params?.type ?? "message",
    ...(params?.name ? { name: params.name } : {}),
    text: params?.text ?? "hello",
    from: { id: "user-1", aadObjectId: "aad-user-1", name: "User" },
    recipient: { id: "bot-1", name: "Bot" },
    conversation: {
      id: params?.conversationId ?? "conversation-1",
      conversationType: "personal",
    },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
  };
}

function runtime() {
  return { error: vi.fn(), log: vi.fn() };
}

function makeIngress(queue: IngressQueue, dispatch: IngressDispatch) {
  return createMSTeamsIngress({
    accountId: "app-id",
    queue,
    dispatch,
    runtime: runtime(),
  });
}

async function withQueue<T>(fn: (queue: IngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<IngressPayload>({
    channelId: "msteams",
    accountId: "app-id",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function waitForVerdict(
  queue: IngressQueue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, {} as IngressPayload);
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 5_000 },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Microsoft Teams durable ingress", () => {
  it("propagates durable append failure before scheduling dispatch", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue: ChannelIngressQueue<IngressPayload> = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      };
      const dispatch = vi.fn();
      const ingress = makeIngress(failingQueue, dispatch);

      await expect(ingress.accept(activity())).rejects.toBe(appendError);
      expect(dispatch).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("does not dispatch a failed append's stale live context on retry", async () => {
    await withQueue(async (queue) => {
      let failNext = true;
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        if (failNext) {
          failNext = false;
          throw new Error("sqlite busy");
        }
        return await enqueue(...args);
      };
      const contexts: unknown[] = [];
      const ingress = createMSTeamsIngress({
        accountId: "default",
        queue,
        runtime: runtime(),
        dispatch: async (_activity, lifecycle, liveContext) => {
          contexts.push(liveContext);
          await lifecycle.onAdopted();
        },
      });
      const staleContext = { id: "stale" } as never;
      const retryContext = { id: "retry" } as never;
      const retryActivity = activity({ id: "activity-ctx-retry" });
      try {
        ingress.start();
        await expect(ingress.accept(retryActivity, staleContext)).rejects.toThrow("sqlite busy");
        // The failed append must uninstall its context; the retry's own
        // context is the one a claim may consume.
        await ingress.accept(retryActivity, retryContext);
        await vi.waitFor(() => expect(contexts).toHaveLength(1));
        expect(contexts[0]).toBe(retryContext);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("recovers an uncompleted append with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const incoming = activity({ id: "activity-restart" });
      const interrupted = makeIngress(queue, vi.fn());
      await interrupted.accept(incoming);
      await interrupted.stop();

      const recoveredDispatch = vi.fn(async (_activity, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = makeIngress(queue, recoveredDispatch);
      recovered.start();
      try {
        await waitForVerdict(queue, "activity-restart", "completed");
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
        expect(recoveredDispatch).toHaveBeenCalledWith(incoming, expect.any(Object), undefined);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone and rejects a post-completion duplicate", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_activity, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = makeIngress(queue, dispatch);
      const incoming = activity({ id: "activity-duplicate" });
      ingress.start();
      try {
        await ingress.accept(incoming);
        await waitForVerdict(queue, "activity-duplicate", "completed");
        await ingress.accept(incoming);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("deduplicates a concrete Bot Framework redelivery by activity.id", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_activity, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = makeIngress(queue, dispatch);
      const first = activity({ id: "bot-framework-redelivery", text: "original" });
      const redelivery = activity({ id: "bot-framework-redelivery", text: "redelivered copy" });
      ingress.start();
      try {
        await ingress.accept(first);
        await waitForVerdict(queue, "bot-framework-redelivery", "completed");
        await ingress.accept(redelivery);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ text: "original" });
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores raw activity JSON and uses the exact conversation.id as its lane", async () => {
    await withQueue(async (queue) => {
      const deliveredText: string[] = [];
      const ingress = makeIngress(queue, async (delivered, lifecycle) => {
        deliveredText.push(delivered.text ?? "");
        await lifecycle.onAdopted();
      });
      const incoming = activity({
        id: "activity-raw",
        conversationId: "19:channel@thread.tacv2;messageid=thread-root",
        text: "before",
      });
      await ingress.accept(incoming);
      const pending = await queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: "activity-raw",
        laneKey: "19:channel@thread.tacv2;messageid=thread-root",
        payload: { version: 1, rawActivity: JSON.stringify(incoming) },
      });
      incoming.text = "after";

      ingress.start();
      try {
        await waitForVerdict(queue, "activity-raw", "completed");
        expect(deliveredText).toEqual(["before"]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("journals only message turns and adaptive-card agent turns", async () => {
    await withQueue(async (queue) => {
      const ingress = makeIngress(queue, vi.fn());
      await ingress.accept(activity({ id: "message", type: "message" }));
      await ingress.accept(
        activity({ id: "adaptive", type: "invoke", name: "adaptiveCard/action" }),
      );
      await ingress.accept(activity({ id: "edit", type: "messageUpdate" }));
      await ingress.accept(activity({ id: "reaction", type: "messageReaction" }));
      await ingress.accept(
        activity({ id: "feedback", type: "invoke", name: "message/submitAction" }),
      );
      await ingress.accept(
        activity({ id: "file-consent", type: "invoke", name: "fileConsent/invoke" }),
      );

      expect(
        (await queue.listPending({ limit: "all" })).map((entry) => entry.id).toSorted(),
      ).toEqual(["adaptive", "message"]);
      await ingress.stop();
    });
  });

  it("dead-letters malformed persisted JSON without dispatch", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "activity-malformed",
        { version: 1, receivedAt: Date.now(), rawActivity: "{" },
        { laneKey: "conversation-1" },
      );
      const dispatch = vi.fn();
      const ingress = makeIngress(queue, dispatch);
      ingress.start();
      try {
        await waitForVerdict(queue, "activity-malformed", "failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("releases transient dispatch failures for retry", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_activity, lifecycle) => {
        if (dispatch.mock.calls.length === 1) {
          throw new Error("temporary dispatch outage");
        }
        await lifecycle.onAdopted();
      });
      const ingress = makeIngress(queue, dispatch);
      ingress.start();
      try {
        await ingress.accept(activity({ id: "activity-retry" }));
        await waitForVerdict(queue, "activity-retry", "completed");
        expect(dispatch).toHaveBeenCalledTimes(2);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters permanent authentication failures without retry", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw Object.assign(new Error("invalid Bot Framework credentials"), { statusCode: 401 });
      });
      const ingress = makeIngress(queue, dispatch);
      ingress.start();
      try {
        await ingress.accept(activity({ id: "activity-auth-failed" }));
        await waitForVerdict(queue, "activity-auth-failed", "failed");
        expect(dispatch).toHaveBeenCalledTimes(1);
        const verdict = await queue.enqueue("activity-auth-failed", {} as IngressPayload);
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("authentication-failed");
        }
      } finally {
        await ingress.stop();
      }
    });
  });

  it("caps active deliveries across repeated drain pumps", async () => {
    await withQueue(async (queue) => {
      let releaseDeliveries: (() => void) | undefined;
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDeliveries = resolve;
      });
      let active = 0;
      let maxActive = 0;
      const dispatch = vi.fn(async (_activity, lifecycle) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await lifecycle.onAdopted();
        try {
          await deliveryGate;
        } finally {
          active -= 1;
        }
      });
      const ingress = makeIngress(queue, dispatch);
      ingress.start();
      try {
        for (let index = 0; index < 9; index += 1) {
          await ingress.accept(
            activity({ id: `activity-concurrency-${index}`, conversationId: `lane-${index}` }),
          );
        }
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(8));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });
        expect(dispatch).toHaveBeenCalledTimes(8);
        expect(maxActive).toBe(8);

        releaseDeliveries?.();
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(9));
        expect(maxActive).toBe(8);
      } finally {
        releaseDeliveries?.();
        await ingress.stop();
      }
    });
  });

  it("waits for active delivery to finish before stopping", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery: (() => void) | undefined;
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const ingress = makeIngress(queue, async (_activity, lifecycle) => {
        await lifecycle.onAdopted();
        await deliveryGate;
      });
      ingress.start();
      await ingress.accept(activity({ id: "activity-stop" }));
      await waitForVerdict(queue, "activity-stop", "completed");

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopped).toBe(false);

      releaseDelivery?.();
      await stopping;
      expect(stopped).toBe(true);
    });
  });
});
