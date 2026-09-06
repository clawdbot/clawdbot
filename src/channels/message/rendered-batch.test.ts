import { describe, expect, it } from "vitest";
import { createRenderedMessageBatchPlan } from "./rendered-batch.js";

describe("createRenderedMessageBatchPlan", () => {
  it("keeps aggregate media counts aligned with normalized media items", () => {
    const plan = createRenderedMessageBatchPlan([
      {
        text: "caption",
        mediaUrls: ["  ", "/tmp/image.png", "\t"],
        audioAsVoice: true,
      },
    ]);

    expect(plan.mediaCount).toBe(1);
    expect(plan.voiceCount).toBe(1);
    expect(plan.items[0]).toMatchObject({
      kinds: ["text", "voice"],
      mediaUrls: ["/tmp/image.png"],
      audioAsVoice: true,
    });
  });

  it("recognizes a presentation heading even when it has no blocks", () => {
    const plan = createRenderedMessageBatchPlan([
      { presentation: { title: "Delivery failed: action required", blocks: [] } },
    ]);

    expect(plan.presentationCount).toBe(1);
    expect(plan.items[0]).toMatchObject({ kinds: ["presentation"], mediaUrls: [] });
  });

  it.each([
    {
      name: "a single attachment repeated in its media alias",
      payload: { mediaUrl: "/tmp/image.png", mediaUrls: ["/tmp/image.png"] },
      expected: ["/tmp/image.png"],
    },
    {
      name: "distinct attachments across both media fields",
      payload: { mediaUrl: "/tmp/first.png", mediaUrls: ["/tmp/second.png"] },
      expected: ["/tmp/first.png", "/tmp/second.png"],
    },
    {
      name: "intentional repeated attachments in the ordered media list",
      payload: { mediaUrl: "/tmp/image.png", mediaUrls: ["/tmp/image.png", "/tmp/image.png"] },
      expected: ["/tmp/image.png", "/tmp/image.png"],
    },
  ])("accounts for $name", ({ payload, expected }) => {
    const plan = createRenderedMessageBatchPlan([payload]);

    expect(plan.mediaCount).toBe(expected.length);
    expect(plan.items[0]?.mediaUrls).toEqual(expected);
  });
});
