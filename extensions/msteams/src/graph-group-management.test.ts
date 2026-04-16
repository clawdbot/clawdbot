import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  addParticipantMSTeams,
  removeParticipantMSTeams,
  renameGroupMSTeams,
} from "./graph-group-management.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  postGraphJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  patchGraphJson: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
    postGraphJson: mockState.postGraphJson,
    deleteGraphRequest: mockState.deleteGraphRequest,
    patchGraphJson: mockState.patchGraphJson,
  };
});

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({
    findPreferredDmByUserId: mockState.findPreferredDmByUserId,
  }),
}));

const TOKEN = "test-graph-token";
const CHAT_ID = "19:abc@thread.tacv2";
const CHANNEL_TO = "team-id-1/channel-id-1";

describe("addParticipantMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("adds member to a chat with default role", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    const result = await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-1",
    });

    expect(result).toEqual({ added: { userId: "user-aad-id-1", chatId: CHAT_ID } });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
      body: {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["member"],
        "user@odata.bind": "https://graph.microsoft.com/v1.0/users('user-aad-id-1')",
      },
    });
  });

  it("adds member to a chat with owner role", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    const result = await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-2",
      role: "owner",
    });

    expect(result).toEqual({ added: { userId: "user-aad-id-2", chatId: CHAT_ID } });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
      body: {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": "https://graph.microsoft.com/v1.0/users('user-aad-id-2')",
      },
    });
  });

  it("normalizes role casing and whitespace", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-2",
      role: " OWNER ",
    });

    expect(mockState.postGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          roles: ["owner"],
        }),
      }),
    );
  });

  it("rejects unknown roles", async () => {
    await expect(
      addParticipantMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        userId: "user-aad-id-2",
        role: "admin",
      }),
    ).rejects.toThrow('role must be "member" or "owner"');

    expect(mockState.postGraphJson).not.toHaveBeenCalled();
  });

  it("constructs correct user@odata.bind URL", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "abc-def-123",
    });

    const calledBody = mockState.postGraphJson.mock.calls[0][0].body;
    expect(calledBody["user@odata.bind"]).toBe(
      "https://graph.microsoft.com/v1.0/users('abc-def-123')",
    );
  });

  it("escapes user ids before building the OData bind URL", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "o'hara@example.com",
    });

    const calledBody = mockState.postGraphJson.mock.calls[0][0].body;
    expect(calledBody["user@odata.bind"]).toBe(
      "https://graph.microsoft.com/v1.0/users('o''hara@example.com')",
    );
  });

  it("adds member to a channel", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    const result = await addParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      userId: "user-aad-id-3",
    });

    expect(result).toEqual({ added: { userId: "user-aad-id-3", chatId: CHANNEL_TO } });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/members",
      body: {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["member"],
        "user@odata.bind": "https://graph.microsoft.com/v1.0/users('user-aad-id-3')",
      },
    });
  });
});

describe("removeParticipantMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("lists members, finds match, deletes by membershipId", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "membership-1", userId: "user-aad-id-1" },
        { id: "membership-2", userId: "user-aad-id-2" },
      ],
    });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-2",
    });

    expect(result).toEqual({ removed: { userId: "user-aad-id-2", chatId: CHAT_ID } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members/membership-2`,
    });
  });

  it("throws when user not found in member list", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "membership-1", userId: "user-aad-id-1" },
        { id: "membership-3", userId: "user-aad-id-3" },
      ],
    });

    await expect(
      removeParticipantMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        userId: "user-not-in-list",
      }),
    ).rejects.toThrow("User user-not-in-list is not a member of this conversation");
  });

  it("removes member from a channel", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "membership-5", userId: "user-aad-id-5" }],
    });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      userId: "user-aad-id-5",
    });

    expect(result).toEqual({ removed: { userId: "user-aad-id-5", chatId: CHANNEL_TO } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/members",
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/members/membership-5",
    });
  });

  it("follows member pagination before concluding the user is missing", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({
        value: [{ id: "membership-1", userId: "user-aad-id-1" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/members?$skip=2",
      })
      .mockResolvedValueOnce({
        value: [{ id: "membership-9", userId: "user-aad-id-9" }],
      });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-9",
    });

    expect(result).toEqual({ removed: { userId: "user-aad-id-9", chatId: CHAT_ID } });
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(1, {
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
    });
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(2, {
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members?$skip=2`,
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members/membership-9`,
    });
  });
});

describe("renameGroupMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("renames a chat with topic", async () => {
    mockState.patchGraphJson.mockResolvedValue(undefined);

    const result = await renameGroupMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      name: "New Chat Name",
    });

    expect(result).toEqual({ renamed: { chatId: CHAT_ID, newName: "New Chat Name" } });
    expect(mockState.patchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}`,
      body: { topic: "New Chat Name" },
    });
  });

  it("renames a channel with displayName", async () => {
    mockState.patchGraphJson.mockResolvedValue(undefined);

    const result = await renameGroupMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      name: "New Channel Name",
    });

    expect(result).toEqual({ renamed: { chatId: CHANNEL_TO, newName: "New Channel Name" } });
    expect(mockState.patchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1",
      body: { displayName: "New Channel Name" },
    });
  });
});
