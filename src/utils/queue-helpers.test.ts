// Queue helper tests cover queue ordering and dedupe utility behavior.
import { describe, expect, it } from "vitest";
import {
  applyQueueDropPolicy,
  applyQueueRuntimeSettings,
  countPendingQueueItems,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
} from "./queue-helpers.js";

describe("applyQueueRuntimeSettings", () => {
  it("updates runtime queue settings with normalization", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "collect",
        debounceMs: -12,
        cap: 9.8,
        dropPolicy: "new",
      },
    });

    expect(target).toEqual({
      mode: "collect",
      debounceMs: 0,
      cap: 9,
      dropPolicy: "new",
    });
  });

  it("keeps existing values when optional settings are missing/invalid", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "queue",
        cap: 0,
      },
    });

    expect(target).toEqual({
      mode: "queue",
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize",
    });
  });
});

describe("queue summary helpers", () => {
  it("renders pending summary state without mutating it", () => {
    const state = {
      droppedCount: 2,
      summaryLines: ["first", "second"],
    };

    const prompt = previewQueueSummaryPrompt({
      state,
      noun: "message",
    });

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).toContain("first");
    expect(state).toEqual({
      droppedCount: 2,
      summaryLines: ["first", "second"],
    });
  });

  it("keeps dropped-item previews free of lone surrogates", () => {
    const queue = {
      items: [{ text: `${"a".repeat(158)}😀tail` }],
      cap: 1,
      dropPolicy: "summarize" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };

    applyQueueDropPolicy({ queue, summarize: (item) => item.text });

    expect(queue.summaryLines).toEqual([`${"a".repeat(158)}…`]);
  });
});

describe("drainCollectQueueStep", () => {
  it("skips when neither force mode nor cross-channel routing is active", async () => {
    const seen: number[] = [];
    const items = [1];
    const collectState = { forceIndividualCollect: false };

    const result = await drainCollectQueueStep({
      collectState,
      isCrossChannel: false,
      items,
      run: async (item) => {
        seen.push(item);
      },
    });

    expect(result).toBe("skipped");
    expect(seen).toStrictEqual([]);
    expect(items).toEqual([1]);
  });

  it("drains one item in force mode", async () => {
    const seen: number[] = [];
    const items = [1, 2];
    const collectState = { forceIndividualCollect: true };

    const result = await drainCollectQueueStep({
      collectState,
      isCrossChannel: false,
      items,
      run: async (item) => {
        seen.push(item);
      },
    });

    expect(result).toBe("drained");
    expect(seen).toEqual([1]);
    expect(items).toEqual([2]);
  });

  it("switches to force mode and returns empty when cross-channel with no queued item", async () => {
    const collectState = { forceIndividualCollect: false };

    const result = await drainCollectQueueStep({
      collectState,
      isCrossChannel: true,
      items: [],
      run: async () => {},
    });

    expect(result).toBe("empty");
    expect(collectState.forceIndividualCollect).toBe(true);
  });
});

describe("drainNextQueueItem", () => {
  it("counts only in-flight identities that still intersect the queue", () => {
    const active = { id: "active" };
    const pending = { id: "pending" };
    const alreadyRemoved = { id: "already-removed" };

    expect(countPendingQueueItems([active, pending], new Set([active, alreadyRemoved]))).toBe(1);
  });

  it("acknowledges after success while keeping the in-memory identity during run", async () => {
    type Item = { id: string };
    const item: Item = { id: "ack-after" };
    const items: Item[] = [item];
    const inFlight = new Set<Item>();
    const events: string[] = [];

    await drainNextQueueItem(
      items,
      async () => {
        events.push(`run:items=${items.length}:inFlight=${inFlight.has(item)}`);
      },
      {
        inFlight,
        acknowledgeAfterSuccess: () => {
          events.push(`ack:items=${items.length}:inFlight=${inFlight.has(item)}`);
        },
      },
    );

    expect(events).toEqual(["run:items=1:inFlight=true", "ack:items=0:inFlight=true"]);
    expect(items).toEqual([]);
    expect(inFlight.size).toBe(0);
  });

  it("does not acknowledge after success when delivery fails and the item is restored", async () => {
    type Item = { id: string };
    const item: Item = { id: "retry-me" };
    const items: Item[] = [item];
    const inFlight = new Set<Item>();
    const acknowledgements: Array<{ items: number; inFlight: boolean }> = [];

    await expect(
      drainNextQueueItem(
        items,
        async () => {
          throw new Error("send failed");
        },
        {
          inFlight,
          acknowledgeAfterSuccess: () => {
            acknowledgements.push({ items: items.length, inFlight: inFlight.has(item) });
          },
        },
      ),
    ).rejects.toThrow("send failed");

    expect(acknowledgements).toEqual([]);
    expect(items).toEqual([item]);
    expect(inFlight.size).toBe(0);
  });

  it("acknowledges after success on fail-closed discard", async () => {
    type Item = { id: string };
    const item: Item = { id: "discard-me" };
    const items: Item[] = [item];
    const inFlight = new Set<Item>();
    const discarded: Item[] = [];
    const acknowledgements: Array<{ items: number; inFlight: boolean }> = [];

    await expect(
      drainNextQueueItem(
        items,
        async () => {
          throw new Error("send failed");
        },
        {
          inFlight,
          shouldRestoreOnError: () => false,
          onDiscard: (discardedItem) => {
            discarded.push(discardedItem);
          },
          acknowledgeAfterSuccess: () => {
            acknowledgements.push({ items: items.length, inFlight: inFlight.has(item) });
          },
        },
      ),
    ).rejects.toThrow("send failed");

    expect(discarded).toEqual([item]);
    expect(acknowledgements).toEqual([{ items: 0, inFlight: true }]);
    expect(items).toEqual([]);
    expect(inFlight.size).toBe(0);
  });

  it("still supports optional acknowledge-before-run for generic callers", async () => {
    type Item = { id: string };
    const item: Item = { id: "ack-first" };
    const items: Item[] = [item];
    const inFlight = new Set<Item>();
    const events: string[] = [];

    await drainNextQueueItem(
      items,
      async () => {
        events.push(`run:items=${items.length}:inFlight=${inFlight.has(item)}`);
      },
      {
        inFlight,
        acknowledgeBeforeRun: () => {
          events.push(`ack:items=${items.length}:inFlight=${inFlight.has(item)}`);
        },
      },
    );

    expect(events).toEqual(["ack:items=1:inFlight=true", "run:items=1:inFlight=true"]);
    expect(items).toEqual([]);
    expect(inFlight.size).toBe(0);
  });

  it("keeps overflow survivors when the queue mutates during an awaited drain", async () => {
    type Item = { id: string };
    const queue = {
      items: [{ id: "m1" }] as Item[],
      cap: 3,
      dropPolicy: "summarize" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const delivered: string[] = [];
    const dropped: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = new Set<Item>();

    const firstDrain = drainNextQueueItem(
      queue.items,
      async (item: Item) => {
        delivered.push(item.id);
        await gate;
      },
      { inFlight },
    );
    await Promise.resolve();

    for (let index = 2; index <= 8; index += 1) {
      const item = { id: `m${index}` };
      const shouldEnqueue = applyQueueDropPolicy({
        queue,
        summarize: (queued) => queued.id,
        inFlight,
        onDrop: (items) => {
          dropped.push(...items.map((queued) => queued.id));
        },
      });
      if (shouldEnqueue) {
        queue.items.push(item);
      }
    }

    release();
    await firstDrain;
    while (
      await drainNextQueueItem(
        queue.items,
        async (item) => {
          delivered.push(item.id);
        },
        { inFlight },
      )
    ) {}

    expect(delivered).toEqual(["m1", "m6", "m7", "m8"]);
    expect(dropped).toEqual(["m2", "m3", "m4", "m5"]);
    expect(queue.items).toEqual([]);
  });

  it("skips in-flight items when selecting drop victims", () => {
    type Item = { id: string };
    const m1: Item = { id: "m1" };
    const m2: Item = { id: "m2" };
    const m3: Item = { id: "m3" };
    const m4: Item = { id: "m4" };
    const queue = {
      items: [m1, m2, m3, m4],
      cap: 2,
      dropPolicy: "old" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const inFlight = new Set<Item>([m1]);
    const dropped: string[] = [];

    applyQueueDropPolicy({
      queue,
      inFlight,
      summarize: (item) => item.id,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(dropped).toEqual(["m2", "m3"]);
    expect(queue.items).toEqual([m1, m4]);
  });

  it("skips protected items when selecting drop victims", () => {
    type Item = { id: string; protected?: boolean };
    const protectedItem: Item = { id: "priority", protected: true };
    const normalA: Item = { id: "a" };
    const normalB: Item = { id: "b" };
    const normalC: Item = { id: "c" };
    const queue = {
      items: [protectedItem, normalA, normalB, normalC],
      cap: 3,
      dropPolicy: "old" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const dropped: string[] = [];

    // pending=4, cap=3 → drop 2 oldest unprotected; protected stays.
    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(true);
    expect(dropped).toEqual(["a", "b"]);
    expect(queue.items).toEqual([protectedItem, normalC]);
  });

  it("rejects admission without mutating when only protected items can be dropped", () => {
    type Item = { id: string; protected?: boolean };
    const priority: Item = { id: "priority", protected: true };
    const alsoProtected: Item = { id: "also", protected: true };
    const queue = {
      items: [priority, alsoProtected],
      cap: 1,
      dropPolicy: "old" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const dropped: string[] = [];

    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(false);
    expect(dropped).toEqual([]);
    expect(queue.items).toEqual([priority, alsoProtected]);
  });

  it("rejects when pending work is only in-flight or protected", () => {
    type Item = { id: string; protected?: boolean };
    const active: Item = { id: "active" };
    const priority: Item = { id: "priority", protected: true };
    const queue = {
      items: [active, priority],
      cap: 1,
      dropPolicy: "old" as const,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const inFlight = new Set<Item>([active]);
    const dropped: string[] = [];

    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      inFlight,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(false);
    expect(dropped).toEqual([]);
    expect(queue.items).toEqual([active, priority]);
  });
});

describe("hasCrossChannelItems", () => {
  it("lets unresolved items join an otherwise single keyed route", () => {
    const items = [
      { id: "unresolved" },
      { id: "first", key: "slack:channel:A" },
      { id: "second", key: "slack:channel:A" },
    ];

    expect(hasCrossChannelItems(items, (item) => ({ key: item.key }))).toBe(false);
  });

  it("still treats distinct keyed routes and explicit cross items as cross-channel", () => {
    expect(
      hasCrossChannelItems([{ key: "slack:channel:A" }, { key: "slack:channel:B" }], (item) => ({
        key: item.key,
      })),
    ).toBe(true);
    expect(
      hasCrossChannelItems([{ key: "slack:channel:A" }, { cross: true }], (item) => item),
    ).toBe(true);
  });
});
