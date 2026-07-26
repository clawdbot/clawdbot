// Handoff media ownership is a delivery-boundary invariant, so these cases model
// a resumed agent that ignores the caption-only reply instruction.
import { describe, expect, it } from "vitest";
import {
  collectHandoffOwnedMediaUrls,
  enforceHandoffMediaDeliveryOwnership,
} from "./handoff-media-delivery-ownership.js";

const generatedImageEvent = {
  type: "task_completion",
  source: "image_generation" as const,
  mediaUrls: ["/tmp/generated-dog.png"],
  attachments: [
    { type: "image" as const, path: "/tmp/generated-dog.png", name: "generated-dog.png" },
    { type: "image" as const, url: "/tmp/generated-cat.png", name: "generated-cat.png" },
  ],
};

const handoffMediaUrls = collectHandoffOwnedMediaUrls([generatedImageEvent]);

describe("collectHandoffOwnedMediaUrls", () => {
  it("collects generated media from event urls and attachments", () => {
    expect(handoffMediaUrls).toEqual(["/tmp/generated-dog.png", "/tmp/generated-cat.png"]);
  });

  it("ignores completions that do not carry generated media", () => {
    expect(
      collectHandoffOwnedMediaUrls([
        { type: "task_completion", source: "subagent", mediaUrls: ["/tmp/subagent.png"] },
        { type: "progress", source: "image_generation", mediaUrls: ["/tmp/progress.png"] },
      ]),
    ).toEqual([]);
  });
});

describe("enforceHandoffMediaDeliveryOwnership", () => {
  it("delivers handoff media once when the reply echoes it as a MEDIA line and an attachment", () => {
    expect(
      enforceHandoffMediaDeliveryOwnership({
        payloads: [
          { text: "Here is your dog!", mediaUrls: ["/tmp/generated-dog.png"] },
          { mediaUrl: "/tmp/generated-dog.png" },
        ],
        handoffMediaUrls,
      }),
    ).toEqual([{ text: "Here is your dog!", mediaUrls: ["/tmp/generated-dog.png"] }]);
  });

  it("treats equivalent local references as the same delivery", () => {
    expect(
      enforceHandoffMediaDeliveryOwnership({
        payloads: [
          { text: "dog", mediaUrls: ["/tmp/generated-dog.png"] },
          { text: "dog again", mediaUrl: "/tmp/./generated-dog.png" },
        ],
        handoffMediaUrls,
      }),
    ).toEqual([{ text: "dog", mediaUrls: ["/tmp/generated-dog.png"] }, { text: "dog again" }]);
  });

  it("keeps the first copy of every handoff artifact across payloads", () => {
    expect(
      enforceHandoffMediaDeliveryOwnership({
        payloads: [
          { text: "both", mediaUrls: ["/tmp/generated-dog.png", "/tmp/generated-cat.png"] },
          { text: "dog again", mediaUrl: "/tmp/generated-dog.png" },
          { mediaUrls: ["/tmp/generated-cat.png"] },
        ],
        handoffMediaUrls,
      }),
    ).toEqual([
      { text: "both", mediaUrls: ["/tmp/generated-dog.png", "/tmp/generated-cat.png"] },
      { text: "dog again" },
    ]);
  });

  it("keeps media the handoff does not own", () => {
    expect(
      enforceHandoffMediaDeliveryOwnership({
        payloads: [
          { text: "first", mediaUrls: ["/tmp/generated-dog.png"] },
          { text: "second", mediaUrls: ["/tmp/generated-dog.png", "/tmp/unrelated-chart.png"] },
          { text: "third", mediaUrls: ["/tmp/unrelated-chart.png"] },
        ],
        handoffMediaUrls,
      }),
    ).toEqual([
      { text: "first", mediaUrls: ["/tmp/generated-dog.png"] },
      { text: "second", mediaUrls: ["/tmp/unrelated-chart.png"] },
      { text: "third", mediaUrls: ["/tmp/unrelated-chart.png"] },
    ]);
  });

  it("leaves payloads untouched without a generated-media handoff", () => {
    const payloads = [
      { text: "hi", mediaUrls: ["/tmp/generated-dog.png"] },
      { mediaUrl: "/tmp/generated-dog.png" },
    ];
    expect(enforceHandoffMediaDeliveryOwnership({ payloads, handoffMediaUrls: [] })).toBe(payloads);
  });

  it("preserves payload flags while stripping a repeat", () => {
    expect(
      enforceHandoffMediaDeliveryOwnership({
        payloads: [
          { mediaUrls: ["/tmp/generated-dog.png"] },
          {
            text: "done",
            mediaUrl: "/tmp/generated-dog.png",
            mediaUrls: ["/tmp/generated-dog.png"],
            trustedLocalMedia: true,
            audioAsVoice: true,
          },
        ],
        handoffMediaUrls,
      }),
    ).toEqual([
      { mediaUrls: ["/tmp/generated-dog.png"] },
      { text: "done", trustedLocalMedia: true },
    ]);
  });

  it("does not rewrite payloads that carry a delivery operation", () => {
    const payloads = [
      { mediaUrls: ["/tmp/generated-dog.png"] },
      { text: "pinned", mediaUrl: "/tmp/generated-dog.png", delivery: { pin: true as const } },
    ];
    expect(enforceHandoffMediaDeliveryOwnership({ payloads, handoffMediaUrls })).toBe(payloads);
  });
});
