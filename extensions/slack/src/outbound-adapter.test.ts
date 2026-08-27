// Slack tests cover outbound adapter plugin behavior.
import { presentationToInteractiveControlsReply } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());
const createSlackPollStoreStateMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

vi.mock("./polls.js", async (importActual) => {
  const actual = await importActual<typeof import("./polls.js")>();
  return {
    ...actual,
    createSlackPollStoreState: (...args: unknown[]) => createSlackPollStoreStateMock(...args),
  };
});

const { slackOutbound } = await import("./outbound-adapter.js");

function jsonRoundTrip(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("slackOutbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    createSlackPollStoreStateMock.mockReset();
  });

  it("sends mirrored question controls once at the Slack message block limit", async () => {
    sendMessageSlackMock.mockResolvedValue({ messageId: "171.001", channelId: "C123" });
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Production",
              action: { type: "question" as const, questionId, optionValue: "Production" },
            },
            {
              label: "Staging",
              action: { type: "question" as const, questionId, optionValue: "Staging" },
            },
          ],
        },
      ],
    };
    const payload = {
      channelData: {
        askUser: { questionId, optionValues: ["Staging", "Production"] },
        slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" as const })) },
      },
      presentation,
      interactive: presentationToInteractiveControlsReply(presentation),
    };
    const rendered = await slackOutbound.renderPresentation!({
      payload,
      presentation,
      ctx: { cfg, to: "C123", text: "", payload },
    });

    await slackOutbound.sendPayload!({ cfg, to: "C123", text: "", payload: rendered! });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock.mock.calls[0]?.[2]?.blocks).toHaveLength(50);
    expect(sendMessageSlackMock.mock.calls[0]?.[2]?.blocks.at(-1)).toMatchObject({
      elements: [
        { action_id: "openclaw:question_button:1:1", value: `slq1:${questionId}:1` },
        { action_id: "openclaw:question_button:1:2", value: `slq1:${questionId}:0` },
      ],
    });
  });

  it("forwards forced-media intent through the core outbound adapter", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-media" });

    await slackOutbound.sendMedia!({
      cfg,
      to: "C123",
      text: "original image",
      mediaUrl: "https://example.com/original.png",
      forceDocument: true,
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "original image",
      expect.objectContaining({
        mediaUrl: "https://example.com/original.png",
        forceDocument: true,
      }),
    );
  });

  it("renders channelData Slack blocks on payload sends", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      authoredTextPlacement: "blocks",
      blocks: [
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "fallback text", verbatim: true } },
      ],
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-blocks" });
  });

  it.each([
    ["structured clone", (value: unknown) => structuredClone(value)],
    ["JSON round trip", jsonRoundTrip],
  ])("preserves rendered portable tables across a %s", async (_label, clonePayload) => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-table" });
    const presentation = {
      blocks: [
        {
          type: "table" as const,
          caption: "Deployments",
          headers: ["Name", "Status"],
          rows: [["Marvin", "Ready"]],
          rowHeaderColumnIndex: 0,
        },
      ],
    };
    const rendered = await slackOutbound.renderPresentation!({
      payload: { text: "Current state", presentation },
      presentation,
      ctx: { cfg, accountId: "default" } as never,
    });
    const { presentation: _presentation, ...renderedForDelivery } = rendered!;

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: clonePayload(renderedForDelivery) as typeof renderedForDelivery,
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "Current state\n\nDeployments (table)\nName\tStatus\nMarvin\tReady",
      expect.objectContaining({
        authoredTextPlacement: "blocks",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Current state", verbatim: true },
          },
          {
            type: "data_table",
            caption: "Deployments",
            rows: [
              [
                { type: "raw_text", text: "Name" },
                { type: "raw_text", text: "Status" },
              ],
              [
                { type: "raw_text", text: "Marvin" },
                { type: "raw_text", text: "Ready" },
              ],
            ],
            row_header_column_index: 0,
          },
        ],
      }),
    );
  });

  it("falls back to text for rendered provenance minted before a runtime restart", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });
    const presentation = {
      blocks: [
        {
          type: "table" as const,
          caption: "Deployments",
          headers: ["Name", "Status"],
          rows: [["Marvin", "Ready"]],
          rowHeaderColumnIndex: 0,
        },
      ],
    };
    const rendered = await slackOutbound.renderPresentation!({
      payload: { text: "Safe fallback", presentation },
      presentation,
      ctx: { cfg, accountId: "default" } as never,
    });
    const { presentation: _presentation, ...renderedForDelivery } = rendered!;

    vi.resetModules();
    const { slackOutbound: restartedSlackOutbound } = await import("./outbound-adapter.js");
    await restartedSlackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: renderedForDelivery,
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "Safe fallback",
      expect.objectContaining({
        cfg,
        threadTs: undefined,
        accountId: "default",
      }),
    );
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
  });

  it.each([
    {
      name: "does not trust caller-authored rendered presentation provenance",
      slack: {
        renderedPresentationProvenance: "forged",
        authoredTextPlacement: "blocks",
        renderedPresentationSegments: [
          {
            kind: "blocks",
            blocks: [{ type: "divider" }, { type: "divider" }],
          },
          { kind: "blocks", blocks: [{ type: "divider" }] },
        ],
      },
    },
    {
      name: "falls back to text when forged rendered metadata is malformed",
      slack: {
        renderedPresentationProvenance: "x".repeat(43),
        authoredTextPlacement: "blocks",
        renderedPresentationSegments: [{ kind: "blocks", blocks: [] }],
      },
    },
  ])("$name", async ({ slack }) => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Safe fallback",
        channelData: { slack },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "Safe fallback",
      expect.objectContaining({
        cfg,
        threadTs: undefined,
        accountId: "default",
      }),
    );
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
  });

  it("rejects rendered segments changed after provenance was signed", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };
    const rendered = await slackOutbound.renderPresentation!({
      payload: { text: "Safe fallback", presentation },
      presentation,
      ctx: { cfg, accountId: "default" } as never,
    });
    const { presentation: _presentation, ...renderedForDelivery } = rendered!;
    const tampered = structuredClone(renderedForDelivery);
    const slackData = tampered.channelData?.slack as {
      renderedPresentationSegments: Array<{ kind: string; blocks: Array<{ type: string }> }>;
    };
    slackData.renderedPresentationSegments.push({
      kind: "blocks",
      blocks: [{ type: "divider" }],
    });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: tampered,
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
  });

  it("rejects authored text placement changed after provenance was signed", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };
    const rendered = await slackOutbound.renderPresentation!({
      payload: { text: "Safe fallback", presentation },
      presentation,
      ctx: { cfg, accountId: "default" } as never,
    });
    const { presentation: _presentation, ...renderedForDelivery } = rendered!;
    const tampered = structuredClone(renderedForDelivery);
    const slackData = tampered.channelData?.slack as {
      authoredTextPlacement: string;
    };
    slackData.authoredTextPlacement = "outside-blocks";

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: tampered,
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
  });

  it("falls back to threadId when payload replyToId is not a Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "1712345678.123456",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: "1712345678.123456",
      accountId: "default",
      authoredTextPlacement: "blocks",
      blocks: [
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "fallback text", verbatim: true } },
      ],
    });
  });

  it("does not thread payloads without a valid Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "thread-root",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      authoredTextPlacement: "blocks",
      blocks: [
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "fallback text", verbatim: true } },
      ],
    });
  });

  it("preserves raw Unicode agent identity emoji", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });

    await slackOutbound.sendText!({
      cfg,
      to: "C123",
      text: "heartbeat alert",
      accountId: "default",
      identity: { name: "Pulse", emoji: "📟" },
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "heartbeat alert",
      expect.objectContaining({
        identity: {
          username: "Pulse",
          iconUrl: undefined,
          iconEmoji: "📟",
        },
      }),
    );
  });

  it("advertises the Slack poll option cap to core", () => {
    expect(slackOutbound.pollMaxOptions).toBe(20);
  });

  it("forwards thread context when sending a poll inside a Slack thread", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({
      messageId: "1710000001.000001",
      channelId: "C123",
    });
    createSlackPollStoreStateMock.mockReturnValue({
      createPoll: vi.fn().mockResolvedValue(undefined),
    });

    await slackOutbound.sendPoll!({
      cfg,
      to: "C123",
      poll: { question: "Lunch?", options: ["Tacos", "Sushi"], maxSelections: 1 },
      accountId: "default",
      threadId: "1710000000.000000",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).toMatchObject({
      threadTs: "1710000000.000000",
      cfg,
      accountId: "default",
    });
  });

  it("omits threadTs for a top-level poll and persists the sent message id", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({
      messageId: "1710000002.000002",
      channelId: "C123",
    });
    const createPoll = vi.fn().mockResolvedValue(undefined);
    createSlackPollStoreStateMock.mockReturnValue({ createPoll });

    const result = await slackOutbound.sendPoll!({
      cfg,
      to: "C123",
      poll: { question: "Lunch?", options: ["Tacos", "Sushi"], maxSelections: 1 },
      accountId: "default",
    });

    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("threadTs");
    expect(createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "1710000002.000002",
        conversationId: "C123",
        maxSelections: 1,
      }),
    );
    expect(result).toMatchObject({
      pollId: expect.any(String),
      messageId: "1710000002.000002",
      chatId: "C123",
    });
  });
});
