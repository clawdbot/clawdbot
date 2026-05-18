import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendAdaptiveCardMSTeams: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  createPoll: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendAdaptiveCardMSTeams: mocks.sendAdaptiveCardMSTeams,
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({
    createPoll: mocks.createPoll,
  }),
}));

import { msteamsOutbound } from "./outbound.js";

const cfg = {
  channels: {
    msteams: {
      appId: "resolved-app-id",
    },
  },
} as OpenClawConfig;

type MSTeamsSendText = NonNullable<typeof msteamsOutbound.sendText>;
type MSTeamsSendMedia = NonNullable<typeof msteamsOutbound.sendMedia>;
type MSTeamsSendPayload = NonNullable<typeof msteamsOutbound.sendPayload>;
type MSTeamsSendPoll = NonNullable<typeof msteamsOutbound.sendPoll>;
type MSTeamsRenderPresentation = NonNullable<typeof msteamsOutbound.renderPresentation>;

function requireSendText(): MSTeamsSendText {
  const sendText = msteamsOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected msteams outbound sendText");
  }
  return sendText;
}

function requireSendMedia(): MSTeamsSendMedia {
  const sendMedia = msteamsOutbound.sendMedia;
  if (!sendMedia) {
    throw new Error("Expected msteams outbound sendMedia");
  }
  return sendMedia;
}

function requireSendPayload(): MSTeamsSendPayload {
  const sendPayload = msteamsOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected msteams outbound sendPayload");
  }
  return sendPayload;
}

function requireSendPoll(): MSTeamsSendPoll {
  const sendPoll = msteamsOutbound.sendPoll;
  if (!sendPoll) {
    throw new Error("Expected msteams outbound sendPoll");
  }
  return sendPoll;
}

function requireRenderPresentation(): MSTeamsRenderPresentation {
  const renderPresentation = msteamsOutbound.renderPresentation;
  if (!renderPresentation) {
    throw new Error("Expected msteams outbound renderPresentation");
  }
  return renderPresentation;
}

type PollRecord = Record<string, unknown> & { createdAt: string };

function firstPollRecord(): PollRecord {
  const [call] = mocks.createPoll.mock.calls;
  if (!call) {
    throw new Error("expected createPoll call");
  }
  const [pollRecord] = call;
  if (!pollRecord || typeof pollRecord !== "object" || Array.isArray(pollRecord)) {
    throw new Error("expected createPoll record");
  }
  if (typeof (pollRecord as { createdAt?: unknown }).createdAt !== "string") {
    throw new Error("expected createPoll record timestamp");
  }
  return pollRecord as PollRecord;
}

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.sendMessageMSTeams.mockResolvedValue({
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    mocks.sendPollMSTeams.mockResolvedValue({
      pollId: "poll-1",
      messageId: "msg-poll-1",
      conversationId: "conv-1",
    });
    mocks.sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "msg-card-1",
      conversationId: "conv-card-1",
    });
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it("advertises durable payload delivery for presentation cards", () => {
    expect(msteamsOutbound.deliveryCapabilities?.durableFinal).toMatchObject({
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    });
  });

  it("passes resolved cfg to sendMessageMSTeams for text sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendText()({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });
  });

  it("passes resolved cfg and media roots for media sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendMedia()({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });
  });

  it("renders and sends presentation payloads as Adaptive Cards", async () => {
    const presentation = {
      title: "Deploy",
      blocks: [
        { type: "text" as const, text: "Finished" },
        {
          type: "buttons" as const,
          buttons: [{ label: "Open", value: "open" }],
        },
      ],
    };
    const payload = {
      text: "Deploy finished",
      presentation,
    };
    const rendered = await requireRenderPresentation()({
      payload,
      presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "Deploy finished",
        payload,
      },
    });

    expect(rendered?.presentation).toBe(presentation);
    expect(rendered?.channelData?.msteams).toEqual({
      presentationCard: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Deploy finished", wrap: true },
          { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
          { type: "TextBlock", text: "Finished", wrap: true },
        ],
        actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
      },
    });

    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "Deploy finished",
      payload: rendered!,
    });

    expect(mocks.sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      card: (rendered?.channelData?.msteams as { presentationCard: unknown }).presentationCard,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-card-1",
      conversationId: "conv-card-1",
    });
  });

  it("falls back to text/media delivery when payload rendering did not produce a card", async () => {
    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "hello",
      payload: {
        text: "hello",
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
  });

  it("chunks text fallback payloads that only carry channel metadata", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-text-1", conversationId: "conv-text" })
      .mockResolvedValueOnce({ messageId: "msg-text-2", conversationId: "conv-text" });
    const text = "x".repeat(4001);

    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text,
      payload: {
        text,
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "x".repeat(4000),
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "x",
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-text-2",
      conversationId: "conv-text",
    });
  });

  it("keeps multi-media payloads on the media fallback path", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    const result = await requireSendPayload()({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: {
        text: "album",
        mediaUrls: ["file:///tmp/one.png", "file:///tmp/two.png"],
        channelData: { msteams: { traceId: "trace-1" } },
      },
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "album",
      mediaUrl: "file:///tmp/one.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "",
      mediaUrl: "file:///tmp/two.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-media-2",
      conversationId: "conv-media",
    });
  });

  it("lets media payloads use text fallback instead of card rendering", async () => {
    const payload = {
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
      },
    };
    const rendered = await requireRenderPresentation()({
      payload,
      presentation: payload.presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        payload,
      },
    });

    expect(rendered).toBeNull();
  });

  it("passes resolved cfg to sendPollMSTeams and stores poll metadata", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await requireSendPoll()({
      cfg,
      to: "conversation:abc",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    });
    const pollRecord = firstPollRecord();
    expect(pollRecord).toEqual({
      id: "poll-1",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: pollRecord?.createdAt,
      conversationId: "conv-1",
      messageId: "msg-poll-1",
      votes: {},
    });
    expect(Number.isNaN(Date.parse(pollRecord?.createdAt))).toBe(false);
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const chunker = msteamsOutbound.chunker;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});
