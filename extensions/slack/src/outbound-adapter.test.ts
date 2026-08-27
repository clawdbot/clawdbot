// Slack tests cover outbound adapter plugin behavior.
import { presentationToInteractiveControlsReply } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

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

  it("sends payload media first, then finalizes with blocks", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "final text",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        presentation: {
          blocks: [
            {
              type: "text",
              text: "Block body",
            },
          ],
        },
      },
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(3);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(1, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/1.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(2, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/2.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(3, "C123", "final text\n\nBlock body", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      authoredTextPlacement: "blocks",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "final text", verbatim: true },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "Block body" },
        },
      ],
    });
    expect(result).toMatchObject({
      channel: "slack",
      messageId: "m-final",
      receipt: {
        platformMessageIds: ["m-media-1", "m-media-2", "m-final"],
        primaryPlatformMessageId: "m-media-1",
        parts: [
          { index: 0, platformMessageId: "m-media-1" },
          { index: 1, platformMessageId: "m-media-2" },
          { index: 2, platformMessageId: "m-final" },
        ],
      },
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

  it("does not trust caller-authored rendered presentation provenance", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Safe fallback",
        channelData: {
          slack: {
            renderedPresentationProvenance: "forged",
            authoredTextPlacement: "blocks",
            renderedPresentationSegments: [
              {
                kind: "blocks",
                blocks: [{ type: "divider" }, { type: "divider" }],
              },
              {
                kind: "blocks",
                blocks: [{ type: "divider" }],
              },
            ],
          },
        },
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

  it("falls back to text when forged rendered metadata is malformed", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Safe fallback",
        channelData: {
          slack: {
            renderedPresentationProvenance: "x".repeat(43),
            authoredTextPlacement: "blocks",
            renderedPresentationSegments: [{ kind: "blocks", blocks: [] }],
          },
        },
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

  it("delivers a TTS voice note as a captioned media upload when no rendered blocks are present", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-voice" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Spoken summary of the deploy.",
        mediaUrl: "file:///tmp/tts/deploy.ogg",
        audioAsVoice: true,
        spokenText: "Spoken summary of the deploy.",
        trustedLocalMedia: true,
      },
      mediaLocalRoots: ["/tmp"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "Spoken summary of the deploy.",
      expect.objectContaining({
        mediaUrl: "file:///tmp/tts/deploy.ogg",
        mediaLocalRoots: ["/tmp"],
      }),
    );
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    expect(result).toMatchObject({ channel: "slack", messageId: "m-voice" });
  });

  it("preserves rendered blocks alongside a TTS voice-note media upload", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-voice" })
      .mockResolvedValueOnce({ messageId: "m-blocks" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Spoken summary of the deploy.",
        mediaUrl: "file:///tmp/tts/deploy.ogg",
        audioAsVoice: true,
        spokenText: "Spoken summary of the deploy.",
        trustedLocalMedia: true,
        presentation: {
          blocks: [{ type: "text", text: "Block body that must accompany the voice note" }],
        },
      },
      mediaLocalRoots: ["/tmp"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(2);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      1,
      "C123",
      "Spoken summary of the deploy.",
      {
        cfg,
        threadTs: undefined,
        accountId: "default",
        mediaUrl: "file:///tmp/tts/deploy.ogg",
        mediaAccess: undefined,
        mediaLocalRoots: ["/tmp"],
        mediaReadFile: undefined,
      },
    );
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      2,
      "C123",
      "Block body that must accompany the voice note",
      expect.objectContaining({
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Block body that must accompany the voice note" },
          },
        ],
      }),
    );
    expect(sendMessageSlackMock.mock.calls[1]?.[2]?.blocks).not.toContainEqual(
      expect.objectContaining({
        text: expect.objectContaining({ text: "Spoken summary of the deploy." }),
      }),
    );
    expect(result).toMatchObject({
      channel: "slack",
      receipt: {
        platformMessageIds: ["m-voice", "m-blocks"],
        primaryPlatformMessageId: "m-voice",
      },
    });
  });

  it("does not take the voice path when audioAsVoice is set but no media is present", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "fallback text",
        audioAsVoice: true,
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).toHaveProperty("blocks");
  });

  it("keeps authored text visible when audioAsVoice is set with rendered blocks but no media", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "Spoken summary that must still appear.",
        audioAsVoice: true,
        presentation: {
          blocks: [{ type: "text", text: "Auxiliary block body" }],
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledOnce();
    const call = sendMessageSlackMock.mock.calls[0];
    expect(call?.[1]).toContain("Spoken summary that must still appear.");
    expect(call?.[2]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({ text: "Spoken summary that must still appear." }),
        }),
      ]),
    );
  });

  it("does not duplicate caption text in rendered blocks across render-then-send", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-voice" })
      .mockResolvedValueOnce({ messageId: "m-blocks" });

    const payload = {
      text: "Spoken summary of the deploy.",
      mediaUrl: "file:///tmp/tts/deploy.ogg",
      audioAsVoice: true,
      spokenText: "Spoken summary of the deploy.",
      trustedLocalMedia: true,
      presentation: {
        blocks: [{ type: "text", text: "Block body that must accompany the voice note" }],
      },
    } satisfies ReplyPayload;
    const rendered = await slackOutbound.renderPresentation!({
      payload,
      presentation: payload.presentation,
      ctx: { cfg, to: "C123", text: "", payload },
    });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: rendered ?? payload,
      mediaLocalRoots: ["/tmp"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(2);
    // The audio upload carries the spoken text as its caption.
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      1,
      "C123",
      "Spoken summary of the deploy.",
      expect.objectContaining({ mediaUrl: "file:///tmp/tts/deploy.ogg" }),
    );
    expect(sendMessageSlackMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    // The follow-up block message carries only the auxiliary content; the
    // spoken summary is not materialized into a section block.
    const blockCall = sendMessageSlackMock.mock.calls[1]?.[2];
    expect(blockCall?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({ text: "Block body that must accompany the voice note" }),
        }),
      ]),
    );
    expect(blockCall?.blocks).not.toContainEqual(
      expect.objectContaining({
        text: expect.objectContaining({ text: "Spoken summary of the deploy." }),
      }),
    );
  });
});
