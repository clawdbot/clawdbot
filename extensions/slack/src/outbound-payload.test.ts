import { installChannelOutboundPayloadContractSuite } from "openclaw/plugin-sdk/channel-contract-testing";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { createSlackOutboundPayloadHarness } from "../test-api.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  return createSlackOutboundPayloadHarness(params);
}

describe("slackOutbound sendPayload", () => {
  it("renders presentation blocks", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Fallback summary",
        presentation: { blocks: [{ type: "divider" }] },
      },
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "Fallback summary",
      expect.objectContaining({
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-1" });
  });

  it("sends media before a separate interactive blocks message", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Approval required",
        mediaUrl: "https://example.com/image.png",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
      sendResults: [{ messageId: "sl-media" }, { messageId: "sl-controls" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      to,
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
      }),
    );
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      to,
      "Approval required",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "actions",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-controls" });
  });

  it("fails when merged Slack blocks exceed the platform limit", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        presentation: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
    });

    await expect(run()).rejects.toThrow(/Slack blocks cannot exceed 50 items/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("offsets presentation controls against native Slack blocks before standalone interactive controls", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Deploy?",
        channelData: {
          slack: {
            blocks: [
              {
                type: "actions",
                block_id: "openclaw_reply_buttons_1",
                elements: [],
              },
            ],
          },
        },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Stage", value: "stage" }],
            },
          ],
        },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledWith(
      to,
      "Deploy?",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({ block_id: "openclaw_reply_buttons_1" }),
          expect.objectContaining({
            block_id: "openclaw_reply_buttons_2",
            elements: [expect.objectContaining({ action_id: "openclaw:reply_button:2:1" })],
          }),
          expect.objectContaining({
            block_id: "openclaw_reply_buttons_3",
            elements: [expect.objectContaining({ action_id: "openclaw:reply_button:3:1" })],
          }),
        ],
      }),
    );
  });
});

describe("Slack outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
});
