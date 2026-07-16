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

    await msteamsOutbound.sendText!({
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

    await msteamsOutbound.sendMedia!({
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

    await msteamsOutbound.sendPoll!({
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
    expect(mocks.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "poll-1",
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      }),
    );
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const chunker = msteamsOutbound.chunker;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});
