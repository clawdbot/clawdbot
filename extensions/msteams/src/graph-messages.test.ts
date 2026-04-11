import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  getMessageMSTeams,
  listPinsMSTeams,
  listReactionsMSTeams,
  pinMessageMSTeams,
  reactMessageMSTeams,
  unpinMessageMSTeams,
  unreactMessageMSTeams,
} from "./graph-messages.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  fetchGraphAbsoluteUrl: vi.fn(),
  postGraphJson: vi.fn(),
  postGraphBetaJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  resolveGraphToken: mockState.resolveGraphToken,
  fetchGraphJson: mockState.fetchGraphJson,
  fetchGraphAbsoluteUrl: mockState.fetchGraphAbsoluteUrl,
  postGraphJson: mockState.postGraphJson,
  postGraphBetaJson: mockState.postGraphBetaJson,
  deleteGraphRequest: mockState.deleteGraphRequest,
}));

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({
    findPreferredDmByUserId: mockState.findPreferredDmByUserId,
  }),
}));

const TOKEN = "test-graph-token";
const CHAT_ID = "19:abc@thread.tacv2";
const CHANNEL_TO = "team-id-1/channel-id-1";

describe("getMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("resolves user: target using graphChatId from store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-framework-dm-id",
      reference: { graphChatId: "19:graph-native-chat@thread.tacv2" },
    });
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "From user DM" },
      createdDateTime: "2026-03-23T12:00:00Z",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-object-id-123",
      messageId: "msg-1",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-object-id-123");
    // Must use the graphChatId, not the Bot Framework conversation ID
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:graph-native-chat@thread.tacv2")}/messages/msg-1`,
    });
  });

  it("falls back to conversationId when it starts with 19:", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "19:resolved-chat@thread.tacv2",
      reference: {},
    });
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-id",
      messageId: "msg-1",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:resolved-chat@thread.tacv2")}/messages/msg-1`,
    });
  });

  it("throws when user: target has no stored conversation", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue(null);

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "user:unknown-user",
        messageId: "msg-1",
      }),
    ).rejects.toThrow("No conversation found for user:unknown-user");
  });

  it("throws when user: target has Bot Framework ID and no graphChatId", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-framework-dm-id",
      reference: {},
    });

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "user:some-user",
        messageId: "msg-1",
      }),
    ).rejects.toThrow("Bot Framework ID");
  });

  it("strips conversation: prefix from target", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      from: undefined,
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: `conversation:${CHAT_ID}`,
      messageId: "msg-1",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
    });
  });

  it("reads a message from a chat conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello world", contentType: "text" },
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({
      id: "msg-1",
      text: "Hello world",
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdAt: "2026-03-23T10:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
    });
  });

  it("reads a message from a channel conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-2",
      body: { content: "Channel message" },
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdDateTime: "2026-03-23T11:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result).toEqual({
      id: "msg-2",
      text: "Channel message",
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdAt: "2026-03-23T11:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
    });
  });
});

describe("pinMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("pins a message in a chat using message@odata.bind", async () => {
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
        "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
      },
    });
  });

  it("throws for channel pin (not supported on Graph v1.0)", async () => {
    await expect(
      pinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        messageId: "msg-2",
      }),
    ).rejects.toThrow("not supported for channel messages");
  });
});

describe("unpinMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

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
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/pinned-1`,
    });
  });

  it("throws for channel unpin (not supported on Graph v1.0)", async () => {
    await expect(
      unpinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        pinnedMessageId: "pinned-2",
      }),
    ).rejects.toThrow("not supported for channel messages");
  });
});

describe("listPinsMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("lists pinned messages in a chat", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "pinned-1",
          message: { id: "msg-1", body: { content: "Pinned msg" } },
        },
        {
          id: "pinned-2",
          message: { id: "msg-2", body: { content: "Another pin" } },
        },
      ],
    });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([
      { id: "pinned-1", pinnedMessageId: "pinned-1", messageId: "msg-1", text: "Pinned msg" },
      { id: "pinned-2", pinnedMessageId: "pinned-2", messageId: "msg-2", text: "Another pin" },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages?$expand=message`,
    });
  });

  it("returns empty array when no pins exist", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([]);
  });

  it("follows @odata.nextLink pagination", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "pinned-1", message: { id: "msg-1", body: { content: "First page" } } }],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/pinnedMessages?$expand=message&$skiptoken=page2",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({
      value: [{ id: "pinned-2", message: { id: "msg-2", body: { content: "Second page" } } }],
    });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([
      { id: "pinned-1", pinnedMessageId: "pinned-1", messageId: "msg-1", text: "First page" },
      { id: "pinned-2", pinnedMessageId: "pinned-2", messageId: "msg-2", text: "Second page" },
    ]);
    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledWith({
      token: TOKEN,
      url: "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/pinnedMessages?$expand=message&$skiptoken=page2",
    });
  });

  it("stops paginating after max pages", async () => {
    // Return nextLink on every page to test the cap
    const makePageResponse = (pageNum: number) => ({
      value: [
        {
          id: `pinned-${pageNum}`,
          message: { id: `msg-${pageNum}`, body: { content: `Page ${pageNum}` } },
        },
      ],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/next?page=${pageNum + 1}`,
    });

    mockState.fetchGraphJson.mockResolvedValue(makePageResponse(1));
    // Pages 2-10 via fetchGraphAbsoluteUrl (page 1 is the initial fetch)
    for (let i = 2; i <= 10; i++) {
      mockState.fetchGraphAbsoluteUrl.mockResolvedValueOnce(makePageResponse(i));
    }

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    // Should collect exactly 10 pages (the max) and stop
    expect(result.pins).toHaveLength(10);
    // fetchGraphAbsoluteUrl should be called 9 times (pages 2-10)
    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(9);
  });

  it("throws for channel list-pins (not supported on Graph v1.0)", async () => {
    await expect(
      listPinsMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
      }),
    ).rejects.toThrow("not supported for channels");
  });
});

describe("reactMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

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

  it("passes through unknown reaction types (Unicode emoji)", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "\u{1F44D}",
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "\u{1F44D}" },
    });
  });

  it("rejects empty reaction type", async () => {
    await expect(
      reactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "",
      }),
    ).rejects.toThrow("Reaction type is required");
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

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

  it("passes through unknown reaction types", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "clap",
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/unsetReaction`,
      body: { reactionType: "clap" },
    });
  });

  it("rejects empty reaction type", async () => {
    await expect(
      unreactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "  ",
      }),
    ).rejects.toThrow("Reaction type is required");
  });
});

describe("listReactionsMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("lists reactions grouped by type with user details", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      reactions: [
        { reactionType: "like", user: { id: "u1", displayName: "Alice" } },
        { reactionType: "like", user: { id: "u2", displayName: "Bob" } },
        { reactionType: "heart", user: { id: "u1", displayName: "Alice" } },
      ],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "like",
        name: "like",
        emoji: "\u{1F44D}",
        count: 2,
        users: [
          { id: "u1", displayName: "Alice" },
          { id: "u2", displayName: "Bob" },
        ],
      },
      {
        reactionType: "heart",
        name: "heart",
        emoji: "\u2764\uFE0F",
        count: 1,
        users: [{ id: "u1", displayName: "Alice" }],
      },
    ]);
  });

  it("returns empty array when message has no reactions", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "No reactions" },
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toEqual([]);
  });

  it("counts reactions from users without an ID (deleted/guest/anonymous)", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      reactions: [
        { reactionType: "like", user: { id: "u1", displayName: "Alice" } },
        { reactionType: "like", user: { displayName: "Deleted User" } },
        { reactionType: "like", user: undefined },
        { reactionType: "like" },
        { reactionType: "heart", user: { id: "u2", displayName: "Bob" } },
      ],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "like",
        name: "like",
        emoji: "\u{1F44D}",
        count: 4,
        users: [{ id: "u1", displayName: "Alice" }],
      },
      {
        reactionType: "heart",
        name: "heart",
        emoji: "\u2764\uFE0F",
        count: 1,
        users: [{ id: "u2", displayName: "Bob" }],
      },
    ]);
  });

  it("fetches from channel path for channel targets", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-2",
      body: { content: "Channel msg" },
      reactions: [{ reactionType: "surprised", user: { id: "u3", displayName: "Carol" } }],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "surprised",
        name: "surprised",
        emoji: "\u{1F62E}",
        count: 1,
        users: [{ id: "u3", displayName: "Carol" }],
      },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
    });
  });
});
