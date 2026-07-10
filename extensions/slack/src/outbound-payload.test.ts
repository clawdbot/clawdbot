// Slack tests cover outbound payload plugin behavior.
import { installChannelOutboundPayloadContractSuite } from "openclaw/plugin-sdk/channel-contract-testing";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { createSlackOutboundPayloadHarness, slackOutbound } from "../test-api.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  return createSlackOutboundPayloadHarness(params);
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function sendCall(sendMock: MockWithCalls, index: number): unknown[] {
  const call = sendMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected Slack send call ${index}`);
  }
  return call;
}

function sendOptions(call: unknown[]): {
  blocks?: Array<{
    block_id?: string;
    elements?: Array<{ action_id?: string }>;
    type?: string;
  }>;
  mediaUrl?: string;
} {
  const options = call?.[2];
  if (!options) {
    throw new Error("Expected Slack send options");
  }
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
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("Fallback summary");
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Fallback summary" } },
      { type: "divider" },
    ]);
    expect(result.channel).toBe("slack");
    expect(result.messageId).toBe("sl-1");
  });

  it("renders native charts with complete top-level accessibility text", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        text: "Revenue summary",
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "bar",
              title: "Quarterly revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "Revenue", values: [120, 145] }],
              xLabel: "Quarter",
            },
          ],
        },
      },
    });

    await run();

    const call = sendCall(sendMock, 0);
    expect(call[1]).toBe(
      [
        "Revenue summary",
        "",
        "Quarterly revenue (bar chart)",
        "X axis: Quarter",
        "- Revenue: Q1: 120; Q2: 145",
      ].join("\n"),
    );
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Revenue summary" } },
      {
        type: "data_visualization",
        title: "Quarterly revenue",
        chart: {
          type: "bar",
          series: [
            {
              name: "Revenue",
              data: [
                { label: "Q1", value: 120 },
                { label: "Q2", value: 145 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"], x_label: "Quarter" },
        },
      },
    ]);
  });

  it("keeps the full portable fallback when any control cannot render natively", async () => {
    const payload: ReplyPayload = {
      text: "Fallback",
      presentation: {
        title: "Actions",
        blocks: [
          { type: "text", text: "Choose an action" },
          {
            type: "buttons",
            buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {},
        to: "C12345",
        text: "",
        payload,
      },
    });

    expect(rendered).toBeNull();
  });

  it("renders the portable fallback visibly when native Slack blocks survive", async () => {
    const payload: ReplyPayload = {
      channelData: { slack: { blocks: [{ type: "divider" }] } },
      presentation: {
        title: "Actions",
        blocks: [
          { type: "text", text: "Choose an action" },
          {
            type: "buttons",
            buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    expect(rendered?.channelData?.slack).toEqual({
      blocks: [{ type: "divider" }],
      presentationBlocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Actions\n\nChoose an action\n\n• Status: `/status`",
          },
        },
      ],
    });
    expect(rendered?.text).toBe("Actions\n\nChoose an action\n\n- Status: `/status`");
  });

  it("renders web-app buttons as native Slack links", async () => {
    const payload: ReplyPayload = {
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Launch",
                value: "approve",
                webApp: { url: "https://example.com/app" },
              },
            ],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    expect(rendered?.channelData?.slack).toEqual({
      presentationBlocks: [
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              type: "button",
              action_id: "openclaw:reply_link:1:1",
              url: "https://example.com/app",
            }),
          ],
        }),
      ],
    });
    const linkButton = (
      rendered?.channelData?.slack as {
        presentationBlocks?: Array<{ elements?: Array<Record<string, unknown>> }>;
      }
    )?.presentationBlocks?.[0]?.elements?.[0];
    expect(linkButton).not.toHaveProperty("value");
  });

  it.each([
    {
      name: "title",
      presentation: { title: "x".repeat(151), blocks: [] },
    },
    {
      name: "text block",
      presentation: { blocks: [{ type: "text", text: "x".repeat(3001) }] },
    },
    {
      name: "context block",
      presentation: { blocks: [{ type: "context", text: "x".repeat(3001) }] },
    },
  ] satisfies Array<{
    name: string;
    presentation: NonNullable<ReplyPayload["presentation"]>;
  }>)("keeps the portable fallback for an oversized $name", async ({ presentation }) => {
    const payload: ReplyPayload = { presentation };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    expect(rendered).toBeNull();
  });

  it("marks a separate visible fallback when presentation cannot fit Slack's block limit", async () => {
    const payload: ReplyPayload = {
      channelData: {
        slack: {
          blocks: Array.from({ length: 49 }, () => ({ type: "divider" })),
        },
      },
      presentation: { title: "Deploy status", blocks: [{ type: "divider" }] },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    expect(rendered?.channelData?.slack).toEqual({
      blocks: Array.from({ length: 49 }, () => ({ type: "divider" })),
      presentationFallbackText: "Deploy status",
    });
    expect(rendered?.text).toBeUndefined();
  });

  it("counts legacy interactive blocks compiled after presentation rendering", async () => {
    const payload: ReplyPayload = {
      text: "Question [[slack_buttons: OK:ok]]",
      channelData: {
        slack: {
          blocks: Array.from({ length: 48 }, () => ({ type: "divider" })),
        },
      },
      presentation: { title: "Deploy status", blocks: [{ type: "divider" }] },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: { interactiveReplies: true },
            },
          },
        },
        accountId: "default",
        to: "C12345",
        text: payload.text ?? "",
        payload,
      },
    });

    expect(rendered?.channelData?.slack).toEqual({
      blocks: Array.from({ length: 48 }, () => ({ type: "divider" })),
      presentationFallbackText: "Deploy status",
    });
  });

  it("does not duplicate text compiled around inline legacy controls", async () => {
    const payload: ReplyPayload = {
      text: "Before [[slack_buttons: OK:ok]] after",
      presentation: { blocks: [{ type: "divider" }] },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: { interactiveReplies: true },
            },
          },
        },
        accountId: "default",
        to: "C12345",
        text: payload.text ?? "",
        payload,
      },
    });

    expect(rendered?.channelData?.slack).toEqual({
      presentationBlocks: [{ type: "divider" }],
    });
    expect(rendered?.interactive?.blocks).toEqual([
      { type: "text", text: "Before" },
      { type: "buttons", buttons: [{ label: "OK", value: "ok" }] },
      { type: "text", text: "after" },
    ]);
  });

  it("sends a block-budget fallback as a separate visible message", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Notification fallback",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
            presentationFallbackText: "Visible presentation fallback",
          },
        },
      },
      sendResults: [{ messageId: "sl-blocks" }, { messageId: "sl-fallback" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendCall(sendMock, 0)[0]).toBe(to);
    expect(sendOptions(sendCall(sendMock, 0)).blocks).toEqual([{ type: "divider" }]);
    expect(sendCall(sendMock, 1)[0]).toBe(to);
    expect(sendCall(sendMock, 1)[1]).toBe("Visible presentation fallback");
    expect(sendCall(sendMock, 1)[2]).not.toHaveProperty("blocks");
    expect(result.messageId).toBe("sl-fallback");
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
    const mediaCall = sendCall(sendMock, 0);
    expect(mediaCall[0]).toBe(to);
    expect(mediaCall[1]).toBe("");
    expect(sendOptions(mediaCall).mediaUrl).toBe("https://example.com/image.png");
    expect(mediaCall[2]).not.toHaveProperty("blocks");
    const controlsCall = sendCall(sendMock, 1);
    expect(controlsCall[0]).toBe(to);
    expect(controlsCall[1]).toBe("Approval required");
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
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("Deploy?");
    const blocks = sendOptions(call).blocks;
    expect(blocks?.[0]?.block_id).toBe("openclaw_reply_buttons_1");
    expect(blocks?.[1]?.type).toBe("section");
    expect(blocks?.[2]?.block_id).toBe("openclaw_reply_buttons_2");
    expect(blocks?.[2]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:2:1");
    expect(blocks?.[3]?.block_id).toBe("openclaw_reply_buttons_3");
    expect(blocks?.[3]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:3:1");
  });
});

describe("Slack outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
});
