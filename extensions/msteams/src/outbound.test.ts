import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  createPoll: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({
    createPoll: mocks.createPoll,
  }),
}));

import { msteamsOutbound } from "./outbound.js";

type MSTeamsSendText = NonNullable<typeof msteamsOutbound.sendText>;
type MSTeamsSendMedia = NonNullable<typeof msteamsOutbound.sendMedia>;
type MSTeamsSendPoll = NonNullable<typeof msteamsOutbound.sendPoll>;

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

function requireSendPoll(): MSTeamsSendPoll {
  const sendPoll = msteamsOutbound.sendPoll;
  if (!sendPoll) {
    throw new Error("Expected msteams outbound sendPoll");
  }
  return sendPoll;
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
    mocks.createPoll.mockResolvedValue(undefined);
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
