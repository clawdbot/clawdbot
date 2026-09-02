// Slack tests cover directory live behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSlackDirectoryGroupsLive, listSlackDirectoryPeersLive } from "./directory-live.js";

const slackClientMocks = vi.hoisted(() => ({
  createSlackLookupClient: vi.fn(),
  usersList: vi.fn(),
  conversationsList: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

const params = { cfg: { channels: { slack: { botToken: "xoxb-test" } } } };

describe("slack directory live cursor pagination", () => {
  beforeEach(() => {
    slackClientMocks.usersList.mockReset();
    slackClientMocks.conversationsList.mockReset();
    slackClientMocks.createSlackLookupClient.mockReset().mockReturnValue({
      users: { list: slackClientMocks.usersList },
      conversations: { list: slackClientMocks.conversationsList },
    });
  });

  it("lists peers across advancing cursors", async () => {
    slackClientMocks.usersList
      .mockResolvedValueOnce({
        members: [{ id: "U1", name: "one" }],
        response_metadata: { next_cursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        members: [{ id: "U2", name: "two" }],
        response_metadata: { next_cursor: "" },
      });

    const rows = await listSlackDirectoryPeersLive(params);

    expect(rows.map((row) => row.id)).toEqual(["user:U1", "user:U2"]);
    expect(slackClientMocks.usersList).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated users.list cursor instead of paginating forever", async () => {
    slackClientMocks.usersList.mockResolvedValue({
      members: [],
      response_metadata: { next_cursor: "cursor-loop" },
    });

    await expect(listSlackDirectoryPeersLive(params)).rejects.toThrow(
      "Slack cursor pagination repeated a cursor",
    );
    expect(slackClientMocks.usersList).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated conversations.list cursor instead of paginating forever", async () => {
    slackClientMocks.conversationsList.mockResolvedValue({
      channels: [],
      response_metadata: { next_cursor: "cursor-loop" },
    });

    await expect(listSlackDirectoryGroupsLive(params)).rejects.toThrow(
      "Slack cursor pagination repeated a cursor",
    );
    expect(slackClientMocks.conversationsList).toHaveBeenCalledTimes(2);
  });
});
