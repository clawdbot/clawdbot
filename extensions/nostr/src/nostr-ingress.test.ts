// Nostr durable ingress tests cover admission ordering, recovery, and tombstones.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Event } from "nostr-tools";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateNostrLegacyRecentEventIds } from "./nostr-ingress-state.js";
import { createNostrIngress } from "./nostr-ingress.js";

type NostrIngressQueue = NonNullable<Parameters<typeof createNostrIngress>[0]["queue"]>;
type NostrIngressPayload = Parameters<NostrIngressQueue["enqueue"]>[1];
type NostrIngressDeliver = Parameters<typeof createNostrIngress>[0]["deliver"];

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "1".repeat(64),
    kind: 4,
    pubkey: "a".repeat(64),
    content: "ciphertext",
    created_at: 1_710_000_000,
    tags: [["p", "b".repeat(64)]],
    sig: "2".repeat(128),
    ...overrides,
  };
}

function startIngress(params: {
  queue: NostrIngressQueue;
  deliver: NostrIngressDeliver;
  afterDurableAppend?: (event: Event) => void;
  legacyEventIds?: readonly string[];
  maxSerializedPayloadBytes?: number;
  maxPendingEvents?: number;
  maxQueuedAdmissions?: number;
  admissionRateLimit?: { windowMs: number; maxEvents: number };
}) {
  return createNostrIngress({
    accountId: "default",
    queue: params.queue,
    deliver: params.deliver,
    afterDurableAppend: params.afterDurableAppend ?? (() => {}),
    legacyEventIds: params.legacyEventIds,
    maxSerializedPayloadBytes: params.maxSerializedPayloadBytes ?? 128 * 1024,
    maxPendingEvents: params.maxPendingEvents ?? 1_000,
    maxQueuedAdmissions: params.maxQueuedAdmissions ?? 1_000,
    admissionRateLimit: params.admissionRateLimit ?? { windowMs: 60_000, maxEvents: 1_000 },
    onError: vi.fn(),
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
}

async function withQueue<T>(fn: (queue: NostrIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<NostrIngressPayload>({
    channelId: "nostr",
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

describe("Nostr durable ingress", () => {
  it("advances the cursor only after exact raw admission into the sender lane", async () => {
    await withQueue(async (queue) => {
      let appendCommitted = false;
      const trackingQueue = {
        ...queue,
        enqueue: vi.fn(async (...args: Parameters<NostrIngressQueue["enqueue"]>) => {
          const result = await queue.enqueue(...args);
          appendCommitted = true;
          return result;
        }),
      } satisfies NostrIngressQueue;
      const afterDurableAppend = vi.fn(() => {
        expect(appendCommitted).toBe(true);
      });
      const ingress = startIngress({
        queue: trackingQueue,
        afterDurableAppend,
        deliver: async (_event, lifecycle) => lifecycle.onDeferred(),
      });
      const event = createEvent();
      try {
        await expect(ingress.receive(event)).resolves.toBe("accepted");
        await ingress.waitForIdle();
        expect(afterDurableAppend).toHaveBeenCalledWith(event);
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: event.id,
            laneKey: `direct:${event.pubkey}`,
            payload: expect.objectContaining({ rawEvent: JSON.stringify(event) }),
          }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("recovers an uncompleted relay event with a fresh drain exactly once", async () => {
    await withQueue(async (queue) => {
      const interrupted = startIngress({
        queue,
        deliver: async (_event, lifecycle) => lifecycle.onDeferred(),
      });
      await interrupted.receive(createEvent({ id: "3".repeat(64) }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDeliver = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startIngress({ queue, deliver: recoveredDeliver });
      try {
        await recovered.waitForIdle();
        expect(recoveredDeliver).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("rejects replay after completion", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = startIngress({ queue, deliver });
      const event = createEvent({ id: "4".repeat(64) });
      try {
        await ingress.receive(event);
        await ingress.waitForIdle();
        await expect(ingress.receive(event)).resolves.toBe("duplicate");
        await ingress.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("migrates the persisted LRU seed into completion tombstones", async () => {
    await withQueue(async (queue) => {
      const legacyId = "5".repeat(64);
      await expect(
        migrateNostrLegacyRecentEventIds({ queue, eventIds: [legacyId, legacyId] }),
      ).resolves.toBe(1);
      expect((await queue.enqueue(legacyId, {} as NostrIngressPayload)).kind).toBe("completed");
    });
  });

  it("does not dispatch when durable append exhausts retries", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies NostrIngressQueue;
      const deliver = vi.fn();
      const ingress = startIngress({ queue: failingQueue, deliver });
      try {
        await expect(ingress.receive(createEvent())).rejects.toThrow(
          "Nostr durable admission failed",
        );
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("bounds the fully serialized payload for escape-heavy events", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(queue.enqueue.bind(queue));
      const trackingQueue = { ...queue, enqueue } satisfies NostrIngressQueue;
      const afterDurableAppend = vi.fn();
      const deliver = vi.fn();
      const ingress = startIngress({
        queue: trackingQueue,
        deliver,
        afterDurableAppend,
        maxSerializedPayloadBytes: 600,
      });
      try {
        await expect(
          ingress.receive(createEvent({ id: "6".repeat(64), content: "\\".repeat(40) })),
        ).rejects.toThrow("exceeds the durable ingress size limit");
        expect(enqueue).not.toHaveBeenCalled();
        expect(afterDurableAppend).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();

        const accepted = createEvent({ id: "9".repeat(64), content: "ok" });
        await expect(ingress.receive(accepted)).resolves.toBe("accepted");
        await ingress.waitForIdle();
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(afterDurableAppend).toHaveBeenCalledWith(accepted);
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("isolates a malformed relay event from later admissions", async () => {
    await withQueue(async (queue) => {
      const ingress = startIngress({
        queue,
        deliver: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
        },
      });
      try {
        await expect(ingress.receive({} as Event)).rejects.toThrow("missing id");
        const cyclic = createEvent({ id: "0".repeat(64) }) as Event & { extra?: unknown };
        cyclic.extra = cyclic;
        await expect(ingress.receive(cyclic)).rejects.toThrow(
          "could not be serialized for durable ingress",
        );
        await expect(ingress.receive(createEvent({ id: "f".repeat(64) }))).resolves.toBe(
          "accepted",
        );
      } finally {
        await ingress.stop();
      }
    });
  });

  it("latches the first append failure across queued admissions", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const enqueue = vi.fn().mockRejectedValue(appendError);
      const failingQueue = { ...queue, enqueue } satisfies NostrIngressQueue;
      const afterDurableAppend = vi.fn();
      const ingress = startIngress({
        queue: failingQueue,
        deliver: vi.fn(),
        afterDurableAppend,
      });
      try {
        const first = ingress.receive(createEvent({ id: "7".repeat(64) }));
        const queued = ingress.receive(createEvent({ id: "8".repeat(64) }));
        await expect(first).rejects.toThrow("Nostr durable admission failed");
        await expect(queued).rejects.toThrow("Nostr durable admission failed");
        expect(enqueue).toHaveBeenCalledTimes(3);
        expect(afterDurableAppend).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("rate-limits admission before durable append", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(queue.enqueue.bind(queue));
      const ingress = startIngress({
        queue: { ...queue, enqueue },
        deliver: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
        },
        admissionRateLimit: { windowMs: 60_000, maxEvents: 1 },
      });
      try {
        await expect(ingress.receive(createEvent({ id: "a".repeat(64) }))).resolves.toBe(
          "accepted",
        );
        await expect(ingress.receive(createEvent({ id: "b".repeat(64) }))).rejects.toThrow(
          "exceeds the durable admission rate",
        );
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("charges rejected events to the admission budget before serialization work", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(queue.enqueue.bind(queue));
      const ingress = startIngress({
        queue: { ...queue, enqueue },
        deliver: vi.fn(),
        maxSerializedPayloadBytes: 600,
        admissionRateLimit: { windowMs: 60_000, maxEvents: 1 },
      });
      try {
        await expect(
          ingress.receive(createEvent({ id: "1".repeat(64), content: "\\".repeat(40) })),
        ).rejects.toThrow("exceeds the durable ingress size limit");
        await expect(ingress.receive(createEvent({ id: "2".repeat(64) }))).rejects.toThrow(
          "exceeds the durable admission rate",
        );
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("applies bounded backpressure without latching admission", async () => {
    await withQueue(async (queue) => {
      const held = createEvent({ id: "c".repeat(64) });
      await queue.enqueue(
        held.id,
        { version: 1, receivedAt: Date.now(), rawEvent: JSON.stringify(held) },
        { laneKey: `direct:${held.pubkey}` },
      );
      const ingress = startIngress({
        queue,
        maxPendingEvents: 1,
        deliver: async (_event, lifecycle) => lifecycle.onDeferred(),
      });
      try {
        await ingress.waitForIdle();
        await expect(ingress.receive(createEvent({ id: "d".repeat(64) }))).rejects.toThrow(
          "exceeds the durable ingress backlog",
        );

        const [heldClaim] = await queue.listClaims();
        if (!heldClaim) {
          throw new Error("expected held ingress claim");
        }
        await queue.complete(heldClaim);
        await expect(ingress.receive(createEvent({ id: "e".repeat(64) }))).resolves.toBe(
          "accepted",
        );
      } finally {
        await ingress.stop();
      }
    });
  });

  it("bounds the in-memory admission chain before queue I/O", async () => {
    await withQueue(async (queue) => {
      let releaseList!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      const blockingQueue = {
        ...queue,
        listPending: vi.fn(async () => {
          await listGate;
          return [];
        }),
      } satisfies NostrIngressQueue;
      const ingress = startIngress({
        queue: blockingQueue,
        maxQueuedAdmissions: 1,
        deliver: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
        },
      });
      try {
        const first = ingress.receive(createEvent({ id: "3".repeat(64) }));
        await expect(ingress.receive(createEvent({ id: "4".repeat(64) }))).rejects.toThrow(
          "exceeds the in-memory admission backlog",
        );
        releaseList();
        await expect(first).resolves.toBe("accepted");
      } finally {
        releaseList();
        await ingress.stop();
      }
    });
  });
});
