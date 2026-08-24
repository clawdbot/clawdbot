// Msteams tests cover graph thread plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  formatThreadContext,
  stripHtmlFromTeamsMessage,
} from "./graph-thread.js";
import { fetchGraphJson } from "./graph.js";

const fetchAllGraphPagesMock = vi.hoisted(() => vi.fn());

vi.mock("./graph.js", () => ({
  fetchGraphJson: vi.fn(),
  fetchAllGraphPages: fetchAllGraphPagesMock,
}));

const firstGraphPath = () => {
  const [call] = fetchAllGraphPagesMock.mock.calls;
  if (!call) {
    throw new Error("expected Graph fetch call");
  }
  return call[0].path;
};

describe("stripHtmlFromTeamsMessage", () => {
  it("preserves @mention display names from <at> tags", () => {
    expect(stripHtmlFromTeamsMessage("<at>Alice</at> hello")).toBe("@Alice hello");
  });

  it("strips other HTML tags", () => {
    expect(stripHtmlFromTeamsMessage("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML5 entities", () => {
    expect(
      stripHtmlFromTeamsMessage("&amp; &lt;b&gt; &quot;x&quot; &#39;y&#39; &nbsp;z &copy;"),
    ).toBe("& <b> \"x\" 'y' z ©");
  });

  it("does not double-decode escaped entities (decodes &amp; last)", () => {
    // Graph encodes literally-typed entity text by escaping its '&' to '&amp;'.
    // Decoding '&amp;' first would re-decode the now-bare '&lt;'/'&gt;' into
    // angle brackets, corrupting the user's literal text.
    expect(stripHtmlFromTeamsMessage("The token is &amp;lt;APIKEY&amp;gt;")).toBe(
      "The token is &lt;APIKEY&gt;",
    );
  });

  it("normalizes multiple whitespace to single space", () => {
    expect(stripHtmlFromTeamsMessage("hello   world")).toBe("hello world");
  });

  it("handles <at> tags with attributes", () => {
    expect(stripHtmlFromTeamsMessage('<at id="123">Bob</at> please review')).toBe(
      "@Bob please review",
    );
  });

  it("returns empty string for empty input", () => {
    expect(stripHtmlFromTeamsMessage("")).toBe("");
  });
});

describe("fetchChannelMessage", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("fetches the parent message with correct path", async () => {
    const mockMsg = { id: "msg-1", body: { content: "hello", contentType: "text" } };
    vi.mocked(fetchGraphJson).mockResolvedValueOnce(mockMsg as never);

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");

    expect(result).toEqual(mockMsg);
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1?$select=id,from,body,createdDateTime",
    });
  });

  it("returns undefined on fetch error", async () => {
    vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("forbidden") as never);

    const result = await fetchChannelMessage("tok", "group-1", "channel-1", "msg-1");
    expect(result).toBeUndefined();
  });

  it("URL-encodes group, channel, and message IDs", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    await fetchChannelMessage("tok", "g/1", "c/2", "m/3");

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g%2F1/channels/c%2F2/messages/m%2F3?$select=id,from,body,createdDateTime",
    });
  });
});

describe("fetchChatMessageText", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("fetches the chat message and strips HTML body to plain text", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      id: "1783379480258",
      body: {
        content: "<p>San Francisco right now: <at>Bot</at> full text</p>",
        contentType: "html",
      },
    } as never);

    const result = await fetchChatMessageText("tok", "19:chat@thread.v2", "1783379480258");

    expect(result).toBe("San Francisco right now: @Bot full text");
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/chats/19%3Achat%40thread.v2/messages/1783379480258",
    });
  });

  it("returns trimmed plain text when body is not HTML", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      body: { content: "  plain body  ", contentType: "text" },
    } as never);

    const result = await fetchChatMessageText("tok", "19:chat", "m-1");
    expect(result).toBe("plain body");
  });

  it("returns undefined on fetch error", async () => {
    vi.mocked(fetchGraphJson).mockRejectedValueOnce(new Error("not found") as never);

    const result = await fetchChatMessageText("tok", "19:chat", "m-1");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the message has no body", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    const result = await fetchChatMessageText("tok", "19:chat", "m-1");
    expect(result).toBeUndefined();
  });

  it("forwards a shared deadline to the Graph request", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);
    const deadline = {
      label: "MS Teams inbound preprocessing",
      timeoutMs: 10_000,
      deadlineAtMs: Date.now() + 10_000,
    };

    await fetchChatMessageText("tok", "19:chat", "m-1", deadline);

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "tok",
      path: "/chats/19%3Achat/messages/m-1",
      deadline,
    });
  });
});

describe("fetchThreadReplies", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
    fetchAllGraphPagesMock.mockReset();
  });

  it("fetches replies with correct path and default limit", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [{ id: "reply-1" }, { id: "reply-2" }],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "group-1", "channel-1", "msg-1");

    expect(result).toHaveLength(2);
    expect(fetchAllGraphPagesMock).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/group-1/channels/channel-1/messages/msg-1/replies?$top=50&$select=id,from,body,createdDateTime",
      maxPages: 50,
    });
  });

  it("clamps limit to 50 maximum", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: Array.from({ length: 60 }, (_, index) => ({
        id: `reply-${index + 1}`,
        createdDateTime: `2026-08-01T00:${String(index).padStart(2, "0")}:00Z`,
      })),
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 200);

    expect(result).toHaveLength(50);
    expect(firstGraphPath()).toContain("$top=50");
  });

  it("clamps limit to 1 minimum", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [
        { id: "reply-1", createdDateTime: "2026-08-01T00:00:00Z" },
        { id: "reply-2", createdDateTime: "2026-08-01T00:01:00Z" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 0);

    expect(result).toStrictEqual([{ id: "reply-2", createdDateTime: "2026-08-01T00:01:00Z" }]);
    expect(firstGraphPath()).toContain("$top=50");
  });

  it("returns empty array when value is missing", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({ items: [], truncated: false } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m");
    expect(result).toStrictEqual([]);
  });

  it("returns the newest replies after pagination", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [
        { id: "reply-3", createdDateTime: "2026-08-01T00:02:00Z" },
        { id: "reply-1", createdDateTime: "2026-08-01T00:00:00Z" },
        { id: "reply-4", createdDateTime: "2026-08-01T00:03:00Z" },
        { id: "reply-2", createdDateTime: "2026-08-01T00:01:00Z" },
      ],
      truncated: false,
    } as never);

    const result = await fetchThreadReplies("tok", "g", "c", "m", 2);

    expect(result.map((reply) => reply.id)).toStrictEqual(["reply-3", "reply-4"]);
    expect(fetchAllGraphPagesMock).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g/channels/c/messages/m/replies?$top=50&$select=id,from,body,createdDateTime",
      maxPages: 50,
    });
  });

  it("rejects a page-capped result instead of returning an old prefix", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [{ id: "old-reply" }],
      truncated: true,
    } as never);

    await expect(fetchThreadReplies("tok", "g", "c", "m")).rejects.toThrow(
      "MS Teams thread replies pagination did not reach the newest replies",
    );
  });

  it("rejects an incomplete timestamp set when selecting a newest window", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({
      items: [{ id: "reply-1" }, { id: "reply-2", createdDateTime: "2026-08-01T00:01:00Z" }],
      truncated: false,
    } as never);

    await expect(fetchThreadReplies("tok", "g", "c", "m", 1)).rejects.toThrow(
      "MS Teams thread replies have incomplete timestamps",
    );
  });

  it("forwards the shared deadline to paginated replies", async () => {
    fetchAllGraphPagesMock.mockResolvedValueOnce({ items: [], truncated: false } as never);
    const deadline = {
      label: "MS Teams inbound preprocessing",
      timeoutMs: 10_000,
      deadlineAtMs: Date.now() + 10_000,
    };

    await fetchThreadReplies("tok", "g", "c", "m", 50, deadline);

    expect(fetchAllGraphPagesMock).toHaveBeenCalledWith({
      token: "tok",
      path: "/teams/g/channels/c/messages/m/replies?$top=50&$select=id,from,body,createdDateTime",
      maxPages: 50,
      deadline,
    });
  });
});

describe("formatThreadContext", () => {
  it("formats messages as sender: content lines", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "Hello!", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "World!", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Alice: Hello!\nBob: World!");
  });

  it("skips the current message by id", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "Hello!", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "Current", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages, "m2")).toBe("Alice: Hello!");
  });

  it("strips HTML from html contentType messages", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Carol" } },
        body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Carol: Hello world");
  });

  it("uses application displayName when user is absent", () => {
    const messages = [
      {
        id: "m1",
        from: { application: { displayName: "BotApp" } },
        body: { content: "automated msg", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("BotApp: automated msg");
  });

  it("skips messages with empty content", () => {
    const messages = [
      {
        id: "m1",
        from: { user: { displayName: "Alice" } },
        body: { content: "", contentType: "text" },
      },
      {
        id: "m2",
        from: { user: { displayName: "Bob" } },
        body: { content: "actual content", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("Bob: actual content");
  });

  it("falls back to 'unknown' sender when from is missing", () => {
    const messages = [
      {
        id: "m1",
        body: { content: "orphan msg", contentType: "text" },
      },
    ];
    expect(formatThreadContext(messages)).toBe("unknown: orphan msg");
  });

  it("returns empty string for empty messages array", () => {
    expect(formatThreadContext([])).toBe("");
  });
});
