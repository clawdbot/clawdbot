import { describe, expect, it } from "vitest";
import { filterMessagingToolMediaDuplicates } from "../auto-reply/reply/reply-payloads-dedupe.js";
import { createRenderedMessageBatchPlan } from "../channels/message/rendered-batch.js";

describe("media retirement outbound non-goals", () => {
  it("keeps canonical lowercase ReplyPayload media fields in rendered batch plans", () => {
    expect(
      createRenderedMessageBatchPlan([
        {
          text: "result",
          mediaUrl: "https://example.test/one.png",
          mediaUrls: ["https://example.test/two.png"],
        },
      ]),
    ).toMatchObject({
      mediaCount: 1,
      items: [
        {
          mediaUrls: ["https://example.test/two.png"],
        },
      ],
    });
  });

  it("continues deduplicating lowercase ReplyPayload media fields", () => {
    expect(
      filterMessagingToolMediaDuplicates({
        payloads: [
          {
            mediaUrl: "https://example.test/one.png",
            mediaUrls: ["https://example.test/two.png", "https://example.test/three.png"],
          },
        ],
        sentMediaUrls: ["https://example.test/one.png", "https://example.test/two.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: ["https://example.test/three.png"] }]);
  });
});
