// Queue helper tests cover queue ordering and dedupe utility behavior.
import { describe, expect, it } from "vitest";
import {
  applyQueueDropPolicy,
  applyQueueRuntimeSettings,
  buildQueueSummaryPrompt,
  clearQueueSummaryState,
  drainCollectItemIfNeeded,
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

  it("buildQueueSummaryPrompt clears state after rendering", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 1,
      summaryLines: ["line"],
    };

    const prompt = buildQueueSummaryPrompt({
      state,
      noun: "announce",
    });

    expect(prompt).toContain("[Queue overflow] Dropped 1 announce due to cap.");
    expect(state).toEqual({
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
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
});

describe("drainCollectItemIfNeeded", () => {
  it("skips when neither force mode nor cross-channel routing is active", async () => {
    const seen: number[] = [];
    const items = [1];

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: false,
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

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: true,
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
    let forced = false;

    const result = await drainCollectItemIfNeeded({
      forceIndividualCollect: false,
      isCrossChannel: true,
      setForceIndividualCollect: (next) => {
        forced = next;
      },
      items: [],
      run: async () => {},
    });

    expect(result).toBe("empty");
    expect(forced).toBe(true);
  });
});

describe("drainNextQueueItem", () => {
  it("keeps overflow survivors when the queue mutates during an awaited drain", async () => {
    type Item = { id: string };
    const queue = {
      items: [{ id: "m1" }],
      cap: 3,
      dropPolicy: "summarize" as const,
      droppedCount: 0,
      summaryLines: [],
    };
    const delivered: string[] = [];
    const dropped: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstDrain = drainNextQueueItem(queue.items, async (item: Item) => {
      delivered.push(item.id);
      await gate;
    });
    await Promise.resolve();

    for (let index = 2; index <= 8; index += 1) {
      const item = { id: `m${index}` };
      const shouldEnqueue = applyQueueDropPolicy({
        queue,
        summarize: (queued) => queued.id,
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
      await drainNextQueueItem(queue.items, async (item) => {
        delivered.push(item.id);
      })
    ) {}

    expect(delivered).toEqual(["m1", "m6", "m7", "m8"]);
    expect(dropped).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(queue.items).toEqual([]);
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
