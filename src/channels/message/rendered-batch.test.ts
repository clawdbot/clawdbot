import { describe, expect, it } from "vitest";
import { createRenderedMessageBatchPlan } from "./rendered-batch.js";

describe("createRenderedMessageBatchPlan", () => {
  it.each([
    {
      name: "matching legacy and plural attachments",
      payload: { mediaUrl: " /tmp/image.png ", mediaUrls: [" /tmp/image.png "] },
      expected: ["/tmp/image.png"],
    },
    {
      name: "plural attachments superseding a legacy attachment",
      payload: {
        mediaUrl: "/tmp/obsolete.png",
        mediaUrls: [" /tmp/first.png ", "", "/tmp/second.png"],
      },
      expected: ["/tmp/first.png", "/tmp/second.png"],
    },
    {
      name: "an empty plural attachment list",
      payload: { mediaUrl: " /tmp/image.png ", mediaUrls: [] },
      expected: ["/tmp/image.png"],
    },
  ])("uses canonical media precedence for $name", ({ payload, expected }) => {
    const plan = createRenderedMessageBatchPlan([payload]);

    expect(plan.mediaCount).toBe(expected.length);
    expect(plan.items[0]?.mediaUrls).toEqual(expected);
  });

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
});
