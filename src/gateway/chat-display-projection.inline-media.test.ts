import { describe, expect, it } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

describe("chat display inline media projection", () => {
  it("redacts Responses input_image data URLs only for stored history", () => {
    const imageUrl = "DATA:image/png;BASE64,cG5n";
    const nestedImageUrl = "data:image/jpeg;base64,anBn";
    const sourceData = "raw-inline-image";
    const message = {
      role: "assistant",
      providerReplay: { opaque: true },
      content: [
        { type: "input_image", image_url: imageUrl },
        { type: "input_image", image_url: { detail: "high", url: nestedImageUrl } },
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
