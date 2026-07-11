// Msteams tests cover graph messages.search plugin behavior.
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
let searchMessagesMSTeams: GraphMessagesTestModule["searchMessagesMSTeams"];

beforeAll(async () => {
  ({ searchMessagesMSTeams } = await loadGraphMessagesTestModule());
});

function readFirstGraphPath(): string {
  const request = mockState.fetchGraphJson.mock.calls[0]?.[0];
  if (!request || typeof request.path !== "string") {
    throw new Error("Expected Graph fetch request path");
  }
  return request.path;
}

describe("searchMessagesMSTeams", () => {
  it("filters chat messages locally and normalizes HTML content", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "<p>Meeting <b>notes</b> from Monday</p>", contentType: "html" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
        {
          id: "msg-2",
          body: { content: "Unrelated update", contentType: "text" },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "meeting notes",
    });

    expect(result).toEqual({
      messages: [
        {
          id: "msg-1",
          text: "<p>Meeting <b>notes</b> from Monday</p>",
          from: { user: { id: "u1", displayName: "Alice" } },
          createdAt: "2026-03-25T10:00:00Z",
        },
      ],
      truncated: false,
    });
    expect(readFirstGraphPath()).toBe(`/chats/${encodeURIComponent(CHAT_ID)}/messages?$top=50`);
  });

  it("keeps channel search scoped to the selected channel", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "msg-2", body: { content: "Sprint review" } }],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      query: "sprint",
    });

    expect(result.messages).toHaveLength(1);
    expect(readFirstGraphPath()).toBe("/teams/team-id-1/channels/channel-id-1/messages?$top=50");
  });

  it("follows target-scoped pagination and applies sender matching locally", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "wrong-sender",
          body: { content: "budget update" },
          from: { user: { id: "u1", displayName: "Bob" } },
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({
      value: [
        {
          id: "right-sender",
          body: { content: "Budget update" },
          from: { application: { id: "app-1", displayName: "Finance Bot" } },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "BUDGET",
      from: "finance bot",
    });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledWith({
      token: TOKEN,
      url: "https://graph.microsoft.com/v1.0/next-page",
    });
    expect(result).toEqual({
      messages: [
        {
          id: "right-sender",
          text: "Budget update",
          from: { application: { id: "app-1", displayName: "Finance Bot" } },
          createdAt: undefined,
        },
      ],
      truncated: false,
    });
  });

  it("matches the sender by stable ID", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "hello" },
          from: { user: { id: "aad-user-1", displayName: "Alice" } },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "hello",
      from: "AAD-USER-1",
    });

    expect(result.messages).toHaveLength(1);
  });

  it("stops at the requested result limit and reports remaining pages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "msg-1", body: { content: "match" } },
        { id: "msg-2", body: { content: "match" } },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "match",
      limit: 1,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(result.truncated).toBe(true);
    expect(mockState.fetchGraphAbsoluteUrl).not.toHaveBeenCalled();
  });

  it("clamps a non-finite limit to the default", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: Array.from({ length: 30 }, (_, index) => ({
        id: `msg-${index}`,
        body: { content: "match" },
      })),
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "match",
      limit: Number.POSITIVE_INFINITY,
    });

    expect(result.messages).toHaveLength(25);
    expect(result.truncated).toBe(true);
  });

  it("reports truncation after the bounded ten-page scan", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2",
    });
    mockState.fetchGraphAbsoluteUrl.mockImplementation(async ({ url }: { url: string }) => {
      const page = Number(url.match(/page-(\d+)/)?.[1] ?? "2");
      return {
        value: [],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/page-${page + 1}`,
      };
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "missing",
    });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(9);
    expect(result).toEqual({ messages: [], truncated: true });
  });

  it("resolves user targets before reading messages", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "19:dm-chat@thread.tacv2",
      reference: {},
    });
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      query: "hello",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    expect(readFirstGraphPath()).toBe(
      `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages?$top=50`,
    );
  });
});
