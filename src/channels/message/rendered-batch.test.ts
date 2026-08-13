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
});
