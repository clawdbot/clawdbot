import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let searchMessagesMSTeams: GraphMessagesTestModule["searchMessagesMSTeams"];

beforeAll(async () => {
  ({ searchMessagesMSTeams } = await loadGraphMessagesTestModule());
});

describe("searchMessagesMSTeams", () => {
  it("searches chat messages with query string", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "Meeting notes from Monday" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "meeting notes",
    });

    expect(result.messages).toEqual([
      {
        id: "msg-1",
        text: "Meeting notes from Monday",
        from: { user: { id: "u1", displayName: "Alice" } },
        createdAt: "2026-03-25T10:00:00Z",
      },
    ]);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(`/chats/${encodeURIComponent(CHAT_ID)}/messages?`);
    expect(calledPath).toContain("$search=");
    expect(calledPath).toContain("$top=25");
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain('$search="meeting notes"');
  });

  it("searches channel messages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-2",
          body: { content: "Sprint review" },
          from: { user: { id: "u2", displayName: "Bob" } },
          createdDateTime: "2026-03-25T11:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      query: "sprint",
    });

    expect(result.messages).toHaveLength(1);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("/teams/team-id-1/channels/channel-id-1/messages?");
  });

  it("applies limit parameter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      limit: 10,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=10");
  });

  it("clamps limit to max 50", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      limit: 100,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=50");
  });

  it("clamps limit to min 1", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      limit: 0,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=1");
  });

  it("applies from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "budget",
      from: "Alice",
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$filter=");
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("from/user/displayName eq 'Alice'");
  });

  it("escapes single quotes in from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      from: "O'Brien",
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("O''Brien");
  });

  it("strips double quotes from query to prevent injection", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: 'say "hello" world',
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain('$search="say hello world"');
    expect(decoded).not.toContain('""');
  });

  it("passes ConsistencyLevel: eventual header", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: "test-graph-token",
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages?$search=${encodeURIComponent(
        '"test"',
      )}&$top=25`,
      headers: { ConsistencyLevel: "eventual" },
    });
  });

  it("returns empty array when no messages match", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "nonexistent",
    });

    expect(result.messages).toStrictEqual([]);
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      query: "hello",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(
      `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages?`,
    );
  });
});
