// Queue helper tests cover queue ordering and dedupe utility behavior.
import { describe, expect, it } from "vitest";
import {
  applyQueueDropPolicy,
  applyQueueRuntimeSettings,
  clearQueueSummaryState,
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
  it("previewQueueSummaryPrompt does not mutate state", () => {
    const state = {
      dropPolicy: "summarize" as const,
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
      dropPolicy: "summarize",
      droppedCount: 2,
      summaryLines: ["first", "second"],
    });
  });

  it("clearQueueSummaryState resets summary counters", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 5,
      summaryLines: ["a", "b"],
    };
    clearQueueSummaryState(state);
    expect(state.droppedCount).toBe(0);
    expect(state.summaryLines).toStrictEqual([]);
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
      inFlight,
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
        inFlight,
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
