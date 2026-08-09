// Slack tests cover actions.read plugin behavior.
import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages, resolveSlackConversationName } from "./actions.js";

const createSlackLookupClientMock = vi.hoisted(() =>
  vi.fn(() => ({ conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() } })),
);

vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));

function createClient() {
  return {
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "general" } })),
      replies: vi.fn(async () => ({ messages: [], has_more: false })),
      history: vi.fn(async () => ({ messages: [], has_more: false })),
    },
  } as unknown as WebClient & {
    conversations: {
      info: ReturnType<typeof vi.fn>;
      replies: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
  };
}

describe("Slack read actions", () => {
  it("resolves the current Slack conversation name without caching failures", async () => {
    const client = createClient();
    client.conversations.info
      .mockRejectedValueOnce(new Error("temporary_failure"))
      .mockResolvedValueOnce({ channel: { name: "  allowed-channel  " } });

    await expect(
      resolveSlackConversationName("C1", { client, token: "xoxp-reader" }),
    ).rejects.toThrow("temporary_failure");
    await expect(
      resolveSlackConversationName("C1", { client, token: "xoxp-reader" }),
    ).resolves.toBe("allowed-channel");
    expect(client.conversations.info).toHaveBeenNthCalledWith(1, { channel: "C1" });
    expect(client.conversations.info).toHaveBeenNthCalledWith(2, { channel: "C1" });
  });

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
      oldest: "171234.567",
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["171234.890", "171235.000"]);
  });

  it("excludes the parent before applying the thread page limit", async () => {
    const client = createClient();
    const threadMessages = [
      { ts: "171234.567", text: "parent" },
      { ts: "171234.890", text: "first reply" },
      { ts: "171235.000", text: "second reply" },
    ];
    client.conversations.replies.mockImplementationOnce(
      ({ oldest, limit }: { oldest?: string; limit?: number }) => {
        const eligible = threadMessages.filter((message) => !oldest || message.ts > oldest);
        return {
          messages: eligible.slice(0, limit),
          has_more: limit !== undefined && eligible.length > limit,
        };
      },
    );

    await expect(
      readSlackMessages("C1", {
        client,
        threadId: "171234.567",
        limit: 1,
        token: "xoxb-test",
      }),
    ).resolves.toEqual({
      messages: [{ ts: "171234.890", text: "first reply" }],
      hasMore: true,
    });
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
      oldest: "171234.890",
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "reply" }],
      hasMore: false,
    });
  });

  it("reads an exact reply directly after more than a full thread page", async () => {
    const client = createClient();
    const threadMessages = Array.from({ length: 102 }, (_, index) => ({
      ts: `171234.${String(index).padStart(6, "0")}`,
      text: index === 101 ? "requested reply" : `message ${String(index)}`,
    }));
    const messageId = "171234.000101";
    client.conversations.replies.mockImplementationOnce(
      ({
        oldest,
        latest,
        inclusive,
        limit,
      }: {
        oldest?: string;
        latest?: string;
        inclusive?: boolean;
        limit?: number;
      }) => {
        const eligible = threadMessages.filter(
          (message) =>
            (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
            (!latest || message.ts < latest || (inclusive && message.ts === latest)),
        );
        return { messages: eligible.slice(0, limit), has_more: eligible.length > (limit ?? 0) };
      },
    );

    await expect(
      readSlackMessages("C1", {
        client,
        threadId: "171234.000000",
        messageId,
        token: "xoxb-test",
      }),
    ).resolves.toEqual({
      messages: [{ ts: messageId, text: "requested reply" }],
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

  it("renders attachment tables in channel reads without dropping raw payloads", async () => {
    const client = createClient();
    const blocks = [
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "ID" },
            { type: "raw_text", text: "Status" },
          ],
          [
            { type: "raw_number", value: 12345 },
            { type: "raw_text", text: "enabled" },
          ],
        ],
      },
    ];
    const attachments = [{ fallback: "[no preview available]", blocks }];
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1", text: "  Please check these.  ", attachments }],
      has_more: false,
    });

    const result = await readSlackMessages("C1", { client, token: "xoxb-test" });

    expect(result.messages[0]?.text).toBe("  Please check these.  \nID\tStatus\n12345\tenabled");
    expect(result.messages[0]?.attachments).toBe(attachments);
    expect(result.messages[0]?.attachments?.[0]?.blocks).toBe(blocks);
  });

  it("renders attachment tables in thread reads", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [
        { ts: "1.000", text: "parent" },
        {
          ts: "1.001",
          text: "Thread data",
          attachments: [
            {
              blocks: [
                {
                  type: "table",
                  rows: [
                    [{ type: "raw_text", text: "Name" }],
                    [{ type: "raw_text", text: "Example A" }],
                  ],
                },
              ],
            },
          ],
        },
      ],
      has_more: false,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "1.000",
      token: "xoxb-test",
    });

    expect(result.messages.map((message) => message.text)).toEqual([
      "Thread data\nName\nExample A",
    ]);
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
      oldest: "171234.890",
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
      oldest: "1712345678.000001",
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("preserves an explicit thread lower bound after the parent timestamp", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      threadId: "1712345678.000001",
      after: "1712345678.000002",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1712345678.000001",
      limit: undefined,
      latest: undefined,
      oldest: "1712345678.000002",
    });
  });

  it("routes read-mode actions through the bounded lookup client", async () => {
    createSlackLookupClientMock.mockReturnValue({
      conversations: {
        info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
        replies: vi.fn(),
        history: vi.fn(),
      },
    });

    await resolveSlackConversationName("C1", {
      token: "test-auth-token",
      cfg: { channels: { slack: { enabled: true, botToken: "test-auth-token" } } },
    } as Parameters<typeof resolveSlackConversationName>[1]);

    expect(createSlackLookupClientMock).toHaveBeenCalledWith("test-auth-token", {
      teamId: undefined,
    });
  });
});
