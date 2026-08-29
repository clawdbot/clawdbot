import { describe, expect, it } from "vitest";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

describe("assistant media directive display projection", () => {
  it("withholds relative MEDIA directives until managed attachment blocks replace them", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: {
          mediaUrls: ["./attachment-catalog-tiny/demo.jpg", "./attachment-catalog-tiny/demo.mp3"],
        },
        content: [
          {
            type: "text",
            text: [
              "Prepared the batch.",
              "MEDIA:./attachment-catalog-tiny/demo.jpg",
              "MEDIA:./attachment-catalog-tiny/demo.mp3",
            ].join("\n"),
          },
        ],
      },
    });
    const message = payload?.message as { content?: Array<{ text?: string }> } | undefined;

    expect(message?.content?.[0]?.text).toBe("Prepared the batch.");
    expect(JSON.stringify(payload)).not.toContain("MEDIA:");
    expect(JSON.stringify(payload)).not.toContain("attachment-catalog-tiny");
  });

  it("keeps a media-only assistant row pending for its structured rewrite", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: { mediaUrls: ["./attachment-catalog-tiny/demo.jpg"] },
        content: [{ type: "text", text: "MEDIA:./attachment-catalog-tiny/demo.jpg" }],
      },
    });

    expect(payload?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  });

  it("preserves fenced MEDIA examples as ordinary assistant text", () => {
    const text = ["```text", "MEDIA:./example.jpg", "```", ""].join("\n");
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(payload?.message).toMatchObject({
      content: [{ type: "text", text }],
    });
  });

  it("preserves legacy remote MEDIA references for client-side attachment projection", () => {
    const text = "MEDIA:https://cdn.example.test/legacy.jpg";
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(payload?.message).toMatchObject({
      content: [{ type: "text", text }],
    });
  });

  it.each(["MEDIA:chart.png", "MEDIA:./image.png"])(
    "preserves an ordinary relative reference through persistence and projection: %s",
    (text) => {
      const persisted = applyAssistantDeliveryDirectives({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      const { payload } = projectSessionMessagePayload({
        sessionKey: "agent:main:main",
        message: persisted,
      });

      expect(payload?.message).toMatchObject({ content: [{ type: "text", text }] });
    },
  );

  it("withholds only relative directives from a mixed legacy batch", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: { mediaUrls: ["./attachment-catalog-tiny/demo.jpg"] },
        content: [
          {
            type: "text",
            text: [
              "Prepared the mixed batch.",
              "MEDIA:https://cdn.example.test/legacy.jpg",
              "MEDIA:/media/legacy-audio.mp3",
              "MEDIA:./attachment-catalog-tiny/demo.jpg",
            ].join("\n"),
          },
        ],
      },
    });

    expect(payload?.message).toMatchObject({
      content: [
        {
          type: "text",
          text: [
            "Prepared the mixed batch.",
            "MEDIA:https://cdn.example.test/legacy.jpg",
            "MEDIA:/media/legacy-audio.mp3",
          ].join("\n"),
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("attachment-catalog-tiny");
  });
});
