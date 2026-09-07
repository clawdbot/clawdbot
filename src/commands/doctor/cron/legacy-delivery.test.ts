// Legacy delivery tests cover cron doctor repair of old delivery state.
import { describe, expect, it } from "vitest";
import { normalizeLegacyDeliveryInput } from "./legacy-delivery.js";

describe("legacy delivery threadId support", () => {
  it("preserves false and zero legacy delivery hints", () => {
    expect(
      normalizeLegacyDeliveryInput({
        payload: { deliver: false, bestEffortDeliver: false, threadId: 0 },
      }),
    ).toEqual({
      delivery: { mode: "none", threadId: "0", bestEffort: false },
      mutated: true,
    });
  });

  it("treats threadId as a legacy delivery hint", () => {
    expect(normalizeLegacyDeliveryInput({ payload: { threadId: "42" } })).toEqual({
      delivery: { mode: "announce", threadId: "42" },
      mutated: true,
    });
    expect(normalizeLegacyDeliveryInput({ payload: { threadId: 42 } })).toEqual({
      delivery: { mode: "announce", threadId: "42" },
      mutated: true,
    });
  });

  it("hydrates threadId into new delivery payloads", () => {
    expect(
      normalizeLegacyDeliveryInput({
        payload: {
          channel: "telegram",
          to: "-100123:topic:42",
          threadId: 42,
        },
      }),
    ).toEqual({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-100123:topic:42",
        threadId: "42",
      },
      mutated: true,
    });
  });

  it("patches and merges threadId into existing deliveries", () => {
    expect(
      normalizeLegacyDeliveryInput({
        delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: "1" },
        payload: { threadId: 77 },
      }),
    ).toEqual({
      delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: "77" },
      mutated: true,
    });
  });

  it("strips threadId from legacy payloads after normalization", () => {
    const payload: Record<string, unknown> = {
      channel: "telegram",
      to: "-100123:topic:42",
      threadId: 42,
    };

    expect(normalizeLegacyDeliveryInput({ payload })).toEqual({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-100123:topic:42",
        threadId: "42",
      },
      mutated: true,
    });
    expect(payload.threadId).toBeUndefined();
  });
});
