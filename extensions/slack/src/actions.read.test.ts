import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages } from "./actions.js";

function createClient() {
  return {
    conversations: {
      replies: vi.fn(async () => ({ messages: [], has_more: false })),
      history: vi.fn(async () => ({ messages: [], has_more: false })),
    },
  } as unknown as WebClient & {
    conversations: {
      replies: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
  };
}

describe("readSlackMessages", () => {
  it("uses conversations.replies and drops the parent message", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890" }, { ts: "171235.000" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: undefined,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["171234.890", "171235.000"]);
  });

  it("filters a specific thread reply by messageId", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890", text: "reply" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      messageId: "171234.890",
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "reply" }],
      hasMore: false,
    });
  });

  it("uses conversations.history when threadId is missing", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1" }],
      has_more: false,
    });

    const result = await readSlackMessages("C1", {
      client,
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 20,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["1"]);
  });

  it("filters a specific channel message by messageId", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "171234.890", text: "exact" }, { ts: "171234.891" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      messageId: "171234.890",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "exact" }],
      hasMore: false,
    });
  });

  it("passes Slack timestamp strings through to history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "1712345678.654321",
      after: "1712340000.000001",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712345678.654321",
      oldest: "1712340000.000001",
    });
  });

  it("converts ISO date strings to epoch seconds for history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "2024-04-05T12:34:56.000Z",
      after: "2024-04-05T00:00:00.000Z",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712320496",
      oldest: "1712275200",
    });
  });

  it("converts ISO date strings with offsets to epoch seconds for history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "2024-04-05T12:34:56+03:00",
      after: "2024-04-05T12:34:56.789+03:00",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712309696",
      oldest: "1712309696.789",
    });
  });

  it.each(["not-a-timestamp", "2024-02-30T00:00:00.000Z", "04/05/2024", "2024-04-05T12:34:56"])(
    "rejects invalid history bound %s with a clear timestamp error",
    async (before) => {
      const client = createClient();

      await expect(
        readSlackMessages("C1", {
          client,
          before,
          token: "xoxb-test",
        }),
      ).rejects.toThrow(
        `Invalid Slack read before timestamp "${before}": expected a Slack timestamp or ISO-8601 date string`,
      );
      expect(client.conversations.history).not.toHaveBeenCalled();
    },
  );

  it("normalizes ISO date strings and Slack timestamp strings for thread reply bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      threadId: "1712345678.000001",
      before: "2024-04-05T12:34:56.000Z",
      after: "1712340000.000001",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1712345678.000001",
      limit: undefined,
      latest: "1712320496",
      oldest: "1712340000.000001",
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });
});
