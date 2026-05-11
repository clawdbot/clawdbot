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

function sendOptions(call: unknown[] | undefined): {
  blocks?: Array<{
    block_id?: string;
    elements?: Array<{ action_id?: string }>;
    type?: string;
  }>;
  mediaUrl?: string;
} {
  const options = call?.[2];
  expect(options).toBeDefined();
  return options as {
    blocks?: Array<{
      block_id?: string;
      elements?: Array<{ action_id?: string }>;
      type?: string;
    }>;
    mediaUrl?: string;
  };
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
    const call = sendMock.mock.calls[0];
    expect(call?.[0]).toBe(to);
    expect(call?.[1]).toBe("Fallback summary");
    expect(sendOptions(call).blocks).toEqual([{ type: "divider" }]);
    expect(result.channel).toBe("slack");
    expect(result.messageId).toBe("sl-1");
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
    const mediaCall = sendMock.mock.calls[0];
    expect(mediaCall?.[0]).toBe(to);
    expect(mediaCall?.[1]).toBe("");
    expect(sendOptions(mediaCall).mediaUrl).toBe("https://example.com/image.png");
    expect(mediaCall?.[2]).not.toHaveProperty("blocks");
    const controlsCall = sendMock.mock.calls[1];
    expect(controlsCall?.[0]).toBe(to);
    expect(controlsCall?.[1]).toBe("Approval required");
    expect(sendOptions(controlsCall).blocks?.[0]?.type).toBe("actions");
    expect(result.channel).toBe("slack");
    expect(result.messageId).toBe("sl-controls");
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

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0];
    expect(call?.[0]).toBe(to);
    expect(call?.[1]).toBe("Deploy?");
    const blocks = sendOptions(call).blocks;
    expect(blocks?.[0]?.block_id).toBe("openclaw_reply_buttons_1");
    expect(blocks?.[1]?.block_id).toBe("openclaw_reply_buttons_2");
    expect(blocks?.[1]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:2:1");
    expect(blocks?.[2]?.block_id).toBe("openclaw_reply_buttons_3");
    expect(blocks?.[2]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:3:1");
  });
});

describe("Slack outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
});
