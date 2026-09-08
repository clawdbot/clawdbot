import { describe, expect, it } from "vitest";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { buildSessionHistorySnapshot } from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

describe("assistant media directive display projection", () => {
  it.each(
    [false, true].flatMap((recovered) =>
      [[], [{ type: "thinking", thinking: "Internal reasoning" }]].map((content) => ({
        recovered,
        content,
      })),
    ),
  )(
    "preserves error-turn media (later reply=$recovered, content=$content)",
    ({ recovered, content }) => {
      const user = { role: "user", content: "hello" };
      const reply = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "I agree with that product direction." }],
        __openclaw: { runId: "run-retry" },
      };
      const mediaReply = {
        role: "assistant",
        content,
        stopReason: "error",
        __openclaw: {
          runId: "run-retry",
          media: [{ path: "media://inbound/synthetic-image", contentType: "image/png" }],
        },
      };
      const rawMessages = [user, mediaReply, ...(recovered ? [reply] : [])];
      const expected = [user, { ...mediaReply, content: [] }, ...(recovered ? [reply] : [])];
      expect(projectChatDisplayMessages(rawMessages)).toEqual(expected);
      expect(buildSessionHistorySnapshot({ rawMessages }).history.messages).toEqual(expected);
    },
  );

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

describe("chat display inline media projection", () => {
  it("redacts Responses input_image data URLs only for stored history", () => {
    const imageUrl = " \tDATA:image/png;BASE64,cG5n";
    const nestedImageUrl = "\n data:image/jpeg;base64,anBn";
    const sourceUrl = "  data:image/webp;base64,d2VicA==";
    const sourceData = "raw-inline-image";
    const message = {
      role: "assistant",
      providerReplay: { opaque: true },
      content: [
        { type: "input_image", image_url: imageUrl },
        { type: "input_image", image_url: { detail: "high", url: nestedImageUrl } },
        { type: "input_image", source: { url: sourceUrl, media_type: "image/webp" } },
        { type: "input_image", source: { data: sourceData, media_type: "image/png" } },
        { type: "input_image", image_url: "https://example.test/image.png" },
      ],
    };

    const live = projectChatDisplayMessages([message]);
    expect(live[0]?.content).toEqual(message.content);

    const stored = projectChatDisplayMessages([message], { redactInlineMedia: true });
    expect(stored).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(imageUrl, "utf8"),
          },
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(nestedImageUrl, "utf8"),
            image_url: {
              detail: "high",
            },
          },
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(sourceUrl, "utf8"),
            source: {
              media_type: "image/webp",
            },
          },
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(sourceData, "utf8"),
            source: {
              media_type: "image/png",
            },
          },
          { type: "input_image", image_url: "https://example.test/image.png" },
        ],
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(imageUrl);
    expect(JSON.stringify(stored)).not.toContain(nestedImageUrl);
    expect(JSON.stringify(stored)).not.toContain(sourceUrl);
    expect(JSON.stringify(stored)).not.toContain(sourceData);
  });

  it("redacts Responses input_image data URLs inside stored nested tool activities", () => {
    const imageUrl = "DATA:image/png;BASE64,bmVzdGVk";
    const activity = createNestedToolActivity({
      runId: "nested-run",
      scopeId: "nested-scope",
      afterEntryId: null,
      startOrder: 0,
      toolCallId: "nested-image-call",
      toolName: "image",
      input: {},
      result: { content: [{ type: "input_image", image_url: imageUrl }] },
      isError: false,
      startedAt: 1,
      timestamp: 2,
    });

    const live = projectChatDisplayMessages([activity]);
    expect(JSON.stringify(live)).toContain(imageUrl);

    const stored = projectChatDisplayMessages([activity], { redactInlineMedia: true });
    expect(stored).toMatchObject([
      {
        content: [
          { type: "toolCall", id: "nested-image-call" },
          {
            type: "toolResult",
            content: [
              {
                type: "input_image",
                omitted: true,
                bytes: Buffer.byteLength(imageUrl, "utf8"),
              },
            ],
          },
        ],
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(imageUrl);
  });
});
