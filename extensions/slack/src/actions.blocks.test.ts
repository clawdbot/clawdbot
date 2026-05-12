import { describe, expect, it } from "vitest";
import { createSlackEditTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";

installSlackBlockTestMocks();
const { editSlackMessage } = await import("./actions.js");
const SLACK_TEXT_LIMIT = 8000;

function readFirstChatUpdatePayload(client: ReturnType<typeof createSlackEditTestClient>): {
  text?: string;
} {
  const [call] = client.chat.update.mock.calls;
  if (!call) {
    throw new Error("expected Slack chat.update call");
  }
  const [payload] = call;
  if (!payload || typeof payload !== "object") {
    throw new Error("expected Slack chat.update payload");
  }
  return payload as { text?: string };
}

describe("editSlackMessage blocks", () => {
  it("updates with valid blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Shared a Block Kit message",
      blocks: [{ type: "divider" }],
    });
  });

  it("uses image block text as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Chart" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Chart",
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Chart" }],
    });
  });

  it("uses video block title as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Walkthrough" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Walkthrough",
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Walkthrough" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });
  });

  it("uses generic file fallback text for file blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Shared a file",
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });
  });

  it("caps long block fallback text while preserving edit blocks", async () => {
    const client = createSlackEditTestClient();
    const longContextText = "a".repeat(3000);
    const blocks = [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: longContextText },
          { type: "mrkdwn", text: longContextText },
          { type: "mrkdwn", text: longContextText },
        ],
      },
    ];

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: `${longContextText} ${longContextText} ${"a".repeat(SLACK_TEXT_LIMIT - longContextText.length * 2 - 3)}…`,
      blocks,
    });
    expect(readFirstChatUpdatePayload(client).text).toHaveLength(SLACK_TEXT_LIMIT);
  });

  it("rejects empty blocks arrays", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks missing a type", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createSlackEditTestClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });
});
