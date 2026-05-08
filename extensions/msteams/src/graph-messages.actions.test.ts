import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  TOKEN,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let pinMessageMSTeams: GraphMessagesTestModule["pinMessageMSTeams"];
let reactMessageMSTeams: GraphMessagesTestModule["reactMessageMSTeams"];
let unpinMessageMSTeams: GraphMessagesTestModule["unpinMessageMSTeams"];
let unreactMessageMSTeams: GraphMessagesTestModule["unreactMessageMSTeams"];

beforeAll(async () => {
  ({ pinMessageMSTeams, reactMessageMSTeams, unpinMessageMSTeams, unreactMessageMSTeams } =
    await loadGraphMessagesTestModule());
});

const emptyReactionCases: Array<{
  name: string;
  invoke: () => Promise<unknown>;
}> = [
  {
    name: "reactMessageMSTeams",
    invoke: () =>
      reactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "   ",
      }),
  },
  {
    name: "unreactMessageMSTeams",
    invoke: () =>
      unreactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "",
      }),
  },
];

describe("MSTeams reaction validation", () => {
  it.each(emptyReactionCases)("$name rejects empty reaction type", async ({ invoke }) => {
    await expect(invoke()).rejects.toThrow(/Reaction type is required/);
  });
});

describe("pinMessageMSTeams", () => {
  it("pins a message in a chat via message@odata.bind body", async () => {
    mockState.postGraphJson.mockResolvedValue({ id: "pinned-1" });

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages`,
      body: {
        "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(
          CHAT_ID,
        )}/messages/${encodeURIComponent("msg-1")}`,
      },
    });
  });

  it("rejects pinning a message in a channel on Graph v1.0", async () => {
    await expect(
      pinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        messageId: "msg-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.postGraphJson).not.toHaveBeenCalled();
  });
});

describe("unpinMessageMSTeams", () => {
  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      pinnedMessageId: "pinned-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/${encodeURIComponent("pinned-1")}`,
    });
  });

  it("rejects unpinning a message from a channel on Graph v1.0", async () => {
    await expect(
      unpinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        pinnedMessageId: "pinned-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("reactMessageMSTeams", () => {
  it("sets a like reaction on a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "like",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "like" },
    });
  });

  it("sets a reaction on a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
      reactionType: "heart",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/setReaction",
      body: { reactionType: "heart" },
    });
  });

  it("normalizes reaction type to lowercase", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "LAUGH",
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "laugh" },
    });
  });

  it("passes through non-well-known reaction types (e.g. Unicode emoji)", async () => {
    // Graph setReaction accepts arbitrary Unicode emoji plus the legacy
    // well-known types; normalizeReactionType only lowercases the legacy set
    // and lets any other non-empty value through unchanged.
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "🎉",
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "🎉" },
    });
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      messageId: "msg-1",
      reactionType: "like",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages/msg-1/setReaction`,
      body: { reactionType: "like" },
    });
  });
});

describe("unreactMessageMSTeams", () => {
  it("removes a reaction from a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "sad",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/unsetReaction`,
      body: { reactionType: "sad" },
    });
  });

  it("removes a reaction from a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
      reactionType: "angry",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/unsetReaction",
      body: { reactionType: "angry" },
    });
  });
});
